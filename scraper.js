// Injected into Medium tab. Returns Promise<{results, failed}> — Chrome awaits it.
(async () => {
  const GQL = `query useStatsPostNewChartDataQuery($postId:ID!,$startAt:Long!,$endAt:Long!,$postStatsDailyBundleInput:PostStatsDailyBundleInput!){post(id:$postId){id earnings{dailyEarnings(startAt:$startAt,endAt:$endAt){periodStartedAt amount __typename}__typename}__typename}postStatsDailyBundle(postStatsDailyBundleInput:$postStatsDailyBundleInput){buckets{dayStartsAt membershipType readersThatReadCount readersThatViewedCount readersThatClappedCount readersThatRepliedCount readersThatHighlightedCount readersThatInitiallyFollowedAuthorFromThisPostCount __typename}__typename}}`;

  const { exportSettings: s } = await chrome.storage.local.get('exportSettings');

  const prog = d => {
    try { chrome.runtime.sendMessage({ action: 'progress', ...d }); } catch {}
  };

  async function gql(postId) {
    const body = JSON.stringify([{
      operationName: 'useStatsPostNewChartDataQuery',
      variables: {
        postId,
        startAt: s.startAt,
        endAt: s.endAt,
        postStatsDailyBundleInput: { postId, fromDayStartsAt: s.startAt, toDayStartsAt: s.endAt }
      },
      query: GQL
    }]);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch('https://medium.com/_/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        return j[0]?.data;
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 500));
        else return null;
      }
    }
  }

  function processDays(data) {
    const earningsMap = {};
    (data?.post?.earnings?.dailyEarnings || []).forEach(e => {
      earningsMap[e.periodStartedAt] = (earningsMap[e.periodStartedAt] || 0) + e.amount;
    });

    const dayMap = {};
    (data?.postStatsDailyBundle?.buckets || []).forEach(b => {
      if (!dayMap[b.dayStartsAt]) dayMap[b.dayStartsAt] = {};
      dayMap[b.dayStartsAt][b.membershipType] = b;
    });

    const days = Object.entries(dayMap).map(([ts, split]) => {
      const M = split.MEMBER, N = split.NONMEMBER;
      const ec = earningsMap[+ts] || 0;
      const date = new Date(+ts).toISOString().slice(0, 10);

      if (s.splitMembership) {
        return {
          date,
          memberViews:      M?.readersThatViewedCount || 0,
          memberReads:      M?.readersThatReadCount || 0,
          memberClaps:      M?.readersThatClappedCount || 0,
          memberReplies:    M?.readersThatRepliedCount || 0,
          memberHighlights: M?.readersThatHighlightedCount || 0,
          memberFollows:    M?.readersThatInitiallyFollowedAuthorFromThisPostCount || 0,
          nonMemberViews:      N?.readersThatViewedCount || 0,
          nonMemberReads:      N?.readersThatReadCount || 0,
          nonMemberClaps:      N?.readersThatClappedCount || 0,
          nonMemberReplies:    N?.readersThatRepliedCount || 0,
          nonMemberHighlights: N?.readersThatHighlightedCount || 0,
          nonMemberFollows:    N?.readersThatInitiallyFollowedAuthorFromThisPostCount || 0,
          earningsCents: ec,
          earningsUSD: +(ec / 100).toFixed(2)
        };
      }

      const sum = f => (M?.[f] || 0) + (N?.[f] || 0);
      return {
        date,
        views:      sum('readersThatViewedCount'),
        reads:      sum('readersThatReadCount'),
        claps:      sum('readersThatClappedCount'),
        replies:    sum('readersThatRepliedCount'),
        highlights: sum('readersThatHighlightedCount'),
        follows:    sum('readersThatInitiallyFollowedAuthorFromThisPostCount'),
        earningsCents: ec,
        earningsUSD: +(ec / 100).toFixed(2)
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    if (s.includeZero) return days;
    return days.filter(d => {
      const { date, earningsCents, earningsUSD, ...counts } = d;
      return Object.values(counts).some(v => v !== 0);
    });
  }

  function getTitle(postId) {
    const statsA = document.querySelector(`a[href*="/stats/post/${postId}"]`);
    if (!statsA) return postId;
    // Walk up ancestor chain looking for any heading element
    let el = statsA.parentElement;
    for (let i = 0; i < 20 && el && el !== document.body; i++) {
      const h = el.querySelector('h1,h2,h3,h4,h5');
      if (h) { const t = h.textContent.trim(); if (t.length > 2) return t; }
      el = el.parentElement;
    }
    // Fallback: find the post's own link (href contains postId but not /stats/),
    // use its text content if substantial, otherwise parse the URL slug
    const postA = document.querySelector(
      `a[href$="${postId}"]:not([href*="/stats/post/"]),a[href*="${postId}/"]:not([href*="/stats/post/"])`
    );
    if (postA) {
      const txt = postA.textContent.trim();
      if (txt.length > 3) return txt;
      const slug = (postA.href.match(/\/([^/?#]+)-[a-f0-9]{8,}(?:[/?#].*)?$/) || [])[1];
      if (slug) return slug.replace(/-/g, ' ');
    }
    return postId;
  }

  const results = [], failed = [];

  if (s.mode === 'single') {
    // Detect title before fetch so it's available even if the fetch fails
    let title = null;
    for (const sel of ['h1','h2','h3','[class*="title" i]','[data-testid*="title" i]']) {
      const t = document.querySelector(sel)?.textContent?.trim();
      if (t && t.length > 3 && !/^medium$/i.test(t)) { title = t; break; }
    }
    title = title || s.postId;
    prog({ current: 0, total: 1, status: 'Fetching story data...' });
    const data = await gql(s.postId);
    if (data) {
      results.push({ postId: s.postId, title, days: processDays(data) });
    } else {
      failed.push(title);
    }
    prog({ current: 1, total: 1, status: 'Done' });

  } else {
    // Check if page is fully scrolled
    const sentinel = document.querySelector(
      '[data-testid="infinite-scroll-sentinel"], .infinite-scroll-component ~ div:last-child'
    );
    if (sentinel && sentinel.getBoundingClientRect().top < window.innerHeight * 3) {
      prog({ warning: 'The stats page may not be fully loaded — scroll to the bottom first to ensure all stories appear.' });
    }

    const ids = [...new Set(
      [...document.querySelectorAll('a[href*="/stats/post/"]')]
        .map(a => a.href.match(/\/stats\/post\/([a-f0-9]+)/)?.[1])
        .filter(Boolean)
    )];

    prog({ current: 0, total: ids.length, status: `Found ${ids.length} stories` });

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const title = getTitle(id);
      const label = title.length > 48 ? title.slice(0, 45) + '…' : title;
      prog({ current: i, total: ids.length, status: label });

      const data = await gql(id);
      if (data) results.push({ postId: id, title, days: processDays(data) });
      else failed.push(title || id);

      if (i < ids.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    prog({ current: ids.length, total: ids.length, status: 'Building export...' });
  }

  return { results, failed };
})();
