/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { TimelineType, TimelineStatus, TimelineTabs } from '../../../../common/types/timeline';

import { Direction } from '../../../graphql/types';
import { defaultHeaders } from '../../components/timeline/body/column_headers/default_headers';
import { normalizeTimeRange } from '../../../common/components/url_state/normalize_time_range';
import { SubsetTimelineModel, TimelineModel } from './model';

// normalizeTimeRange uses getTimeRangeSettings which cannot be used outside Kibana context if the uiSettings is not false
const { from: start, to: end } = normalizeTimeRange({ from: '', to: '' }, false);

export const timelineDefaults: SubsetTimelineModel & Pick<TimelineModel, 'filters'> = {
  activeTab: TimelineTabs.query,
  columns: defaultHeaders,
  dataProviders: [],
  dateRange: { start, end },
  deletedEventIds: [],
  description: '',
  eventType: 'all',
  eventIdToNoteIds: {},
  excludedRowRendererIds: [],
  expandedEvent: {},
  highlightedDropAndProviderId: '',
  historyIds: [],
  filters: [],
  indexNames: [],
  isFavorite: false,
  isLive: false,
  isSelectAllChecked: false,
  isLoading: false,
  isSaving: false,
  itemsPerPage: 25,
  itemsPerPageOptions: [10, 25, 50, 100],
  kqlMode: 'filter',
  kqlQuery: {
    filterQuery: null,
  },
  loadingEventIds: [],
  title: '',
  timelineType: TimelineType.default,
  templateTimelineId: null,
  templateTimelineVersion: null,
  noteIds: [],
  pinnedEventIds: {},
  pinnedEventsSaveObject: {},
  savedObjectId: null,
  selectedEventIds: {},
  show: false,
  showCheckboxes: false,
  sort: [
    {
      columnId: '@timestamp',
      columnType: 'number',
      sortDirection: Direction.desc,
    },
  ],
  status: TimelineStatus.draft,
  version: null,
};
