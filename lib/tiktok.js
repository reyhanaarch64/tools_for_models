const { request } = require('./http');

function numberOrZero(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function stalkTikTok(username, deep = false) {
  const clean = String(username || '').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9._]{1,40}$/.test(clean)) throw new Error('invalid TikTok username');
  const url = `https://www.tiktok.com/@${encodeURIComponent(clean)}`;
  const response = await request('GET', url, {
    timeoutMs: 9000,
    maxBytes: 2 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.tiktok.com/'
    }
  });
  if (response.status !== 200) return { error: true, message: `status code ${response.status}`, username: clean };
  const match = response.text.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return { error: true, message: 'rehydration data not found (possible anti-bot response)', username: clean };
  let data;
  try { data = JSON.parse(match[1]); } catch (error) { return { error: true, message: 'rehydration JSON could not be parsed', username: clean }; }
  const detail = data?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
  if (!detail || !detail.userInfo) return { error: true, message: 'userInfo not found (private, unavailable, or anti-bot response)', username: clean };
  const info = detail.userInfo;
  const u = info.user || {};
  const s = info.stats || {};
  const s2 = info.statsV2 || {};
  const result = {
    username: u.uniqueId || clean,
    nickname: u.nickname || null,
    bio: u.signature || null,
    verified: !!u.verified,
    private: !!u.privateAccount,
    isOrganization: !!u.isOrganization,
    id: u.id || null,
    secUid: u.secUid || null,
    language: u.language || null,
    createTime: u.createTime || null,
    createTimeFormatted: u.createTime ? new Date(u.createTime * 1000).toISOString() : null,
    bioLink: u.bioLink?.link || null,
    stats: {
      followers: numberOrZero(s.followerCount || s2.followerCount),
      following: numberOrZero(s.followingCount || s2.followingCount),
      likes: numberOrZero(s.heartCount || s.heart || s2.heartCount || s2.heart),
      videos: numberOrZero(s.videoCount || s2.videoCount),
      friends: numberOrZero(s.friendCount || s2.friendCount),
      digg: numberOrZero(s.diggCount || s2.diggCount)
    },
    avatar: { larger: u.avatarLarger || null, medium: u.avatarMedium || null, thumb: u.avatarThumb || null }
  };
  if (deep) {
    const items = Array.isArray(info.itemList) ? info.itemList : [];
    result.deep = {
      fullUser: u,
      fullStats: s,
      fullStatsV2: s2,
      itemList: items,
      itemListCount: items.length,
      shareMeta: detail.shareMeta || null,
      statusCode: detail.statusCode,
      note: 'liked videos, reposts, and complete video lists may require additional signed requests; this tool returns data present in the profile page rehydration payload.'
    };
    if (items.length) {
      result.deep.recentVideos = items.map(item => ({
        id: item.id,
        desc: item.desc || null,
        createTime: item.createTime || null,
        stats: item.stats || null,
        videoUrl: item.video?.playAddr || item.video?.downloadAddr || null,
        cover: item.video?.cover || null,
        duration: item.video?.duration || null,
        author: item.author?.uniqueId || null
      }));
    }
  }
  return result;
}

module.exports = { stalkTikTok };
