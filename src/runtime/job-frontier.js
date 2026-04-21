import { setTimeout as sleep } from 'node:timers/promises';
import { getRequestGroupKey, getRequestLaneKey } from './request-queue.js';

export function frontierSnapshot(runner) {
  const nowMs = Date.now();
  const activeGroups = Object.fromEntries([...runner.state.activeGroupCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const recentDispatches = Object.fromEntries(
    [...runner.state.recentGroupDispatches.entries()]
      .map(([groupKey, timestamps]) => {
        const retained = timestamps.filter((value) => runner.config.frontier.budgetWindowMs <= 0 || Number(value) >= nowMs - runner.config.frontier.budgetWindowMs);
        return [groupKey, retained.length];
      })
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const activeLanes = Object.fromEntries([...runner.state.activeLaneCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const recentLaneDispatches = Object.fromEntries(
    [...runner.state.recentLaneDispatches.entries()]
      .map(([laneKey, timestamps]) => {
        const laneConfig = runner.config.discoveryLaneConfigs[laneKey] ?? {};
        const budgetWindowMs = Math.max(0, Number(laneConfig.budgetWindowMs ?? 0));
        const retained = timestamps.filter((value) => budgetWindowMs <= 0 || Number(value) >= nowMs - budgetWindowMs);
        return [laneKey, retained.length];
      })
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    hostAwareScheduling: runner.config.frontier.hostAwareScheduling,
    groupBy: runner.config.frontier.groupBy,
    maxInProgressPerGroup: runner.config.frontier.maxInProgressPerGroup,
    maxInProgressPerHost: runner.config.frontier.maxInProgressPerGroup,
    budgetWindowMs: runner.config.frontier.budgetWindowMs,
    maxRequestsPerWindow: runner.config.frontier.maxRequestsPerWindow,
    seenSet: runner.services.requestQueue.seenSetSummary?.() ?? runner.config.frontier.seenSet,
    groupBackoff: runner.services.groupBackoff.snapshot(),
    activeGroupCount: runner.state.activeGroupCounts.size,
    activeGroups,
    recentDispatches,
    lanes: runner.config.discoveryLaneConfigs,
    activeLaneCount: runner.state.activeLaneCounts.size,
    activeLanes,
    recentLaneDispatches,
    priority: runner.config.queuePriority,
  };
}

export function changeTrackingSnapshot(runner) {
  const fieldCounts = new Map();
  for (const entry of runner.state.changeFeed) {
    for (const fieldChange of entry.fieldChanges ?? []) {
      fieldCounts.set(fieldChange.field, Number(fieldCounts.get(fieldChange.field) ?? 0) + 1);
    }
  }

  return {
    changedResultCount: runner.state.changeFeed.length,
    fieldChangeCount: runner.state.changeFeed.reduce((sum, entry) => sum + Number(entry.fieldChanges?.length ?? 0), 0),
    topChangedFields: [...fieldCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([field, count]) => ({ field, count })),
    cache: runner.services.httpCache.snapshot(),
  };
}

export function pruneRecentDispatches(runner, nowMs = Date.now()) {
  if (runner.config.frontier.budgetWindowMs <= 0) {
    runner.state.recentGroupDispatches.clear();
    return;
  }

  const cutoff = nowMs - runner.config.frontier.budgetWindowMs;
  for (const [groupKey, timestamps] of runner.state.recentGroupDispatches.entries()) {
    const retained = timestamps.filter((value) => Number(value) >= cutoff);
    if (retained.length > 0) {
      runner.state.recentGroupDispatches.set(groupKey, retained);
    } else {
      runner.state.recentGroupDispatches.delete(groupKey);
    }
  }

  for (const [laneKey, timestamps] of runner.state.recentLaneDispatches.entries()) {
    const laneConfig = runner.config.discoveryLaneConfigs[laneKey] ?? {};
    const budgetWindowMs = Math.max(0, Number(laneConfig.budgetWindowMs ?? 0));
    if (budgetWindowMs <= 0) {
      runner.state.recentLaneDispatches.delete(laneKey);
      continue;
    }

    const cutoff = nowMs - budgetWindowMs;
    const retained = timestamps.filter((value) => Number(value) >= cutoff);
    if (retained.length > 0) {
      runner.state.recentLaneDispatches.set(laneKey, retained);
    } else {
      runner.state.recentLaneDispatches.delete(laneKey);
    }
  }
}

export function trackDispatchStart(runner, item) {
  const groupKey = item.groupKey ?? getRequestGroupKey(item, runner.config.frontier.groupBy);
  const laneKey = item.laneKey ?? getRequestLaneKey(item);

  const nowMs = Date.now();
  pruneRecentDispatches(runner, nowMs);
  if (groupKey) {
    runner.state.activeGroupCounts.set(groupKey, Number(runner.state.activeGroupCounts.get(groupKey) ?? 0) + 1);
    const timestamps = runner.state.recentGroupDispatches.get(groupKey) ?? [];
    timestamps.push(nowMs);
    runner.state.recentGroupDispatches.set(groupKey, timestamps);
  }
  if (laneKey && runner.config.discoveryLaneConfigs[laneKey]) {
    runner.state.activeLaneCounts.set(laneKey, Number(runner.state.activeLaneCounts.get(laneKey) ?? 0) + 1);
    const timestamps = runner.state.recentLaneDispatches.get(laneKey) ?? [];
    timestamps.push(nowMs);
    runner.state.recentLaneDispatches.set(laneKey, timestamps);
  }

  return { groupKey, laneKey };
}

export function trackDispatchFinish(runner, state = {}) {
  const groupKey = state?.groupKey ?? null;
  const laneKey = state?.laneKey ?? null;

  if (groupKey) {
    const nextCount = Number(runner.state.activeGroupCounts.get(groupKey) ?? 0) - 1;
    if (nextCount > 0) {
      runner.state.activeGroupCounts.set(groupKey, nextCount);
    } else {
      runner.state.activeGroupCounts.delete(groupKey);
    }
  }

  if (laneKey) {
    const nextCount = Number(runner.state.activeLaneCounts.get(laneKey) ?? 0) - 1;
    if (nextCount > 0) {
      runner.state.activeLaneCounts.set(laneKey, nextCount);
    } else {
      runner.state.activeLaneCounts.delete(laneKey);
    }
  }
}

export function getSeedRequests(workflow) {
  if (Array.isArray(workflow.seedRequests) && workflow.seedRequests.length > 0) {
    return workflow.seedRequests;
  }

  return workflow.seedUrls.map((url) => ({ url }));
}

export async function enqueueInitialRequests(runner, seedRequests) {
  for (const seedRequest of seedRequests) {
    await runner.actions.enqueue({
      ...seedRequest,
      depth: 0,
      parentUrl: null,
    });
  }

  await runner.services.crawlPolicy.seedSitemaps(
    seedRequests.map((request) => request.url),
    async (url, sitemapUrl) => runner.actions.enqueue({
      url,
      depth: 0,
      parentUrl: null,
      metadata: {
        source: 'sitemap',
        sitemapUrl,
      },
    }),
  );
}

export function buildDequeueOptions(runner) {
  return {
    ...(runner.config.distributedArtifactsEnabled
      ? {
          useBackendFrontierState: true,
        }
      : {
          activeGroups: runner.state.activeGroupCounts,
          recentGroupDispatches: runner.state.recentGroupDispatches,
          activeLanes: runner.state.activeLaneCounts,
          recentLaneDispatches: runner.state.recentLaneDispatches,
        }),
    laneConfigs: runner.config.discoveryLaneConfigs,
    blockedGroups: runner.services.groupBackoff.blockedGroups(),
    hostAwareScheduling: runner.config.frontier.hostAwareScheduling,
    groupBy: runner.config.frontier.groupBy,
    maxInProgressPerGroup: runner.config.frontier.maxInProgressPerGroup,
    maxInProgressPerHost: runner.config.frontier.maxInProgressPerGroup,
    budgetWindowMs: runner.config.frontier.budgetWindowMs,
    maxRequestsPerWindow: runner.config.frontier.maxRequestsPerWindow,
  };
}

export async function dequeueNextDispatchItem(runner) {
  pruneRecentDispatches(runner);
  return runner.services.requestQueue.dequeue(buildDequeueOptions(runner));
}

export function scheduleItemProcessing(runner, item) {
  const dispatchState = trackDispatchStart(runner, item);
  const task = runner.actions.processItem(item)
    .catch(async (error) => runner.actions.handleFailedItem({ item, error }))
    .finally(() => {
      trackDispatchFinish(runner, dispatchState);
      runner.state.pending.delete(task);
    });

  runner.state.pending.add(task);
  return task;
}

export async function dispatchAvailableItems(runner) {
  while (runner.services.requestQueue.hasPending() && runner.state.pending.size < runner.services.autoscaler.limit()) {
    const item = await dequeueNextDispatchItem(runner);
    if (!item) {
      break;
    }

    scheduleItemProcessing(runner, item);
  }
}

export async function waitForDispatchProgress(runner) {
  if (runner.state.pending.size > 0) {
    await Promise.race(runner.state.pending);
    return;
  }

  if (!runner.services.requestQueue.hasPending()) {
    return;
  }

  const dispatchDelayMs = runner.actions.nextDispatchDelayMs();
  if (dispatchDelayMs > 0) {
    await sleep(dispatchDelayMs);
  } else {
    await sleep(10);
  }
}
