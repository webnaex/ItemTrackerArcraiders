const BASE_URL = 'https://arctracker.io';

const USER_KEYS = {
  consta: process.env.ARCTRACKER_USER_KEY_CONSTA,
  silverbase: process.env.ARCTRACKER_USER_KEY_SILVERBASE,
};

async function arcFetch(path, account, params = {}) {
  const userKey = USER_KEYS[account];
  if (!userKey) throw new Error(`Kein User-Key für Account: ${account}`);

  const url = new URL(BASE_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      'X-App-Key': process.env.ARCTRACKER_APP_KEY,
      'Authorization': `Bearer ${userKey}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`ARCTracker API ${res.status}: ${err?.error?.message || res.statusText}`);
  }

  return res.json();
}

// Kompletten Stash eines Accounts laden (paginiert)
export async function getFullStash(account, locale = 'de') {
  const allItems = [];
  let page = 1;
  const per_page = 500;

  while (true) {
    const { data } = await arcFetch('/api/v2/user/stash', account, { locale, page, per_page });
    const items = data?.items ?? [];
    allItems.push(...items);

    if (items.length < per_page) break;
    page++;
  }

  return allItems;
}

export async function getProfile(account) {
  const { data } = await arcFetch('/api/v2/user/profile', account);
  return data;
}
