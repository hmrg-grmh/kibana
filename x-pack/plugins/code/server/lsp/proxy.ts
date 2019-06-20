/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import EventEmitter from 'events';
import * as net from 'net';
import { fileURLToPath } from 'url';
import {
  createMessageConnection,
  MessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
} from 'vscode-jsonrpc';
import { ResponseMessage } from 'vscode-jsonrpc/lib/messages';

import {
  ClientCapabilities,
  ExitNotification,
  InitializedNotification,
  InitializeResult,
  LogMessageNotification,
  MessageType,
  WorkspaceFolder,
} from 'vscode-languageserver-protocol/lib/main';

import { LspRequest } from '../../model';
import { Logger } from '../log';
import { LspOptions } from '../server_options';
import { Cancelable } from '../utils/cancelable';
import { RequestCancelled } from '../../common/lsp_error_codes';

export interface ILanguageServerHandler {
  lastAccess?: number;
  handleRequest(request: LspRequest): Promise<ResponseMessage>;
  exit(): Promise<any>;
  unloadWorkspace(workspaceDir: string): Promise<void>;
}

export class LanguageServerProxy implements ILanguageServerHandler {
  private error: any | null = null;
  public get isClosed() {
    return this.closed;
  }

  public initialized: boolean = false;
  private socket: any;
  private clientConnection: MessageConnection | null = null;
  private closed: boolean = false;
  private readonly targetHost: string;
  private targetPort: number;
  private readonly logger: Logger;
  private readonly lspOptions: LspOptions;
  private eventEmitter = new EventEmitter();
  private connectingPromise: Cancelable<MessageConnection> | null = null;

  constructor(targetPort: number, targetHost: string, logger: Logger, lspOptions: LspOptions) {
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.logger = logger;
    this.lspOptions = lspOptions;
  }

  public async handleRequest(request: LspRequest): Promise<ResponseMessage> {
    const response: ResponseMessage = {
      jsonrpc: '',
      id: null,
      error: { code: RequestCancelled, message: 'Server closed' },
    };
    if (this.closed) {
      response.error = { code: RequestCancelled, message: 'Server closed' };
    } else {
      const conn = await this.connect();
      const params = Array.isArray(request.params) ? request.params : [request.params];
      if (!request.isNotification) {
        try {
          response.result = await conn.sendRequest(request.method, ...params);
        } catch (error) {
          response.error = error;
        }
      } else {
        conn.sendNotification(request.method, ...params);
      }
    }
    return response;
  }

  public async initialize(
    clientCapabilities: ClientCapabilities,
    workspaceFolders: [WorkspaceFolder],
    initOptions?: object
  ): Promise<InitializeResult> {
    if (this.error) {
      throw this.error;
    }
    const clientConn = await this.connect();
    const rootUri = workspaceFolders[0].uri;
    const params = {
      processId: null,
      workspaceFolders,
      rootUri,
      capabilities: clientCapabilities,
      rootPath: fileURLToPath(rootUri),
    };
    return await clientConn
      .sendRequest(
        'initialize',
        initOptions ? { ...params, initializationOptions: initOptions } : params
      )
      .then(r => {
        this.logger.info(`initialized at ${rootUri}`);

        // @ts-ignore
        // TODO fix this
        clientConn.sendNotification(InitializedNotification.type, {});
        this.initialized = true;
        return r as InitializeResult;
      });
  }

  public async shutdown() {
    const clientConn = await this.connect();
    this.logger.info(`sending shutdown request`);
    return await clientConn.sendRequest('shutdown');
  }
  /**
   * send a exit request to Language Server
   * https://microsoft.github.io/language-server-protocol/specification#exit
   */
  public async exit() {
    this.closed = true; // stop the socket reconnect
    if (this.clientConnection) {
      this.logger.info('sending `shutdown` request to language server.');
      const clientConn = this.clientConnection;
      clientConn.sendRequest('shutdown');
      this.logger.info('sending `exit` notification to language server.');
      // @ts-ignore
      clientConn.sendNotification(ExitNotification.type);
    }
    this.eventEmitter.emit('exit');
  }

  public awaitServerConnection() {
    // prevent calling this method multiple times which may cause 'port already in use' error
    if (!this.connectingPromise) {
      this.connectingPromise = new Cancelable((res, rej, onCancel) => {
        const server = net.createServer(socket => {
          this.initialized = false;
          server.close();
          this.eventEmitter.emit('connect');
          socket.on('close', () => this.onSocketClosed());

          this.logger.info('langserver connection established on port ' + this.targetPort);

          const reader = new SocketMessageReader(socket);
          const writer = new SocketMessageWriter(socket);
          this.clientConnection = createMessageConnection(reader, writer, this.logger);
          this.registerOnNotificationHandler(this.clientConnection);
          this.clientConnection.listen();
          res(this.clientConnection);
        });
        server.on('error', rej);
        server.listen(this.targetPort, () => {
          server.removeListener('error', rej);
          this.logger.info('Wait langserver connection on port ' + this.targetPort);
        });
        onCancel!(error => {
          server.close();
          rej(error);
        });
      });
    }
    return this.connectingPromise.promise;
  }

  /**
   * get notification when proxy's socket disconnect
   * @param listener
   */
  public onDisconnected(listener: () => void) {
    this.eventEmitter.on('close', listener);
  }

  public onExit(listener: () => void) {
    this.eventEmitter.on('exit', listener);
  }

  /**
   * get notification when proxy's socket connect
   * @param listener
   */
  public onConnected(listener: () => void) {
    this.eventEmitter.on('connect', listener);
  }

  public connect(): Promise<MessageConnection> {
    if (this.clientConnection) {
      return Promise.resolve(this.clientConnection);
    }
    if (!this.connectingPromise) {
      this.connectingPromise = new Cancelable(resolve => {
        this.socket = new net.Socket();

        this.socket.on('connect', () => {
          const reader = new SocketMessageReader(this.socket);
          const writer = new SocketMessageWriter(this.socket);
          this.clientConnection = createMessageConnection(reader, writer, this.logger);
          this.registerOnNotificationHandler(this.clientConnection);
          this.clientConnection.listen();
          resolve(this.clientConnection);
          this.eventEmitter.emit('connect');
        });

        this.socket.on('close', () => this.onSocketClosed());

        this.socket.on('error', () => void 0);
        this.socket.on('timeout', () => void 0);
        this.socket.on('drain', () => void 0);
        this.socket.connect(
          this.targetPort,
          this.targetHost
        );
      });
    }
    return this.connectingPromise.promise;
  }

  public unloadWorkspace(workspaceDir: string): Promise<void> {
    return Promise.reject('should not hit here');
  }

  private onSocketClosed() {
    this.clientConnection = null;
    this.connectingPromise = null;
    this.eventEmitter.emit('close');
  }

  private registerOnNotificationHandler(clientConnection: MessageConnection) {
    // @ts-ignore
    clientConnection.onNotification(LogMessageNotification.type, notification => {
      switch (notification.type) {
        case MessageType.Log:
          this.logger.debug(notification.message);
          break;
        case MessageType.Info:
          if (this.lspOptions.verbose) {
            this.logger.info(notification.message);
          } else {
            this.logger.debug(notification.message);
          }
          break;
        case MessageType.Warning:
          if (this.lspOptions.verbose) {
            this.logger.warn(notification.message);
          } else {
            this.logger.log(notification.message);
          }
          break;
        case MessageType.Error:
          if (this.lspOptions.verbose) {
            this.logger.error(notification.message);
          } else {
            this.logger.warn(notification.message);
          }
          break;
      }
    });
  }

  public changePort(port: number) {
    if (port !== this.targetPort) {
      this.targetPort = port;
      if (this.connectingPromise) {
        this.connectingPromise.cancel();
        this.connectingPromise = null;
      }
    }
  }

  public setError(error: any) {
    if (this.connectingPromise) {
      this.connectingPromise.cancel(error);
      this.connectingPromise = null;
    }
    this.error = error;
  }
}
