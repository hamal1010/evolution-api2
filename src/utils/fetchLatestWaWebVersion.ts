import axios, { AxiosRequestConfig } from 'axios';
import { fetchLatestBaileysVersion, WAVersion } from 'baileys';

export const fetchLatestWaWebVersion = async (options: AxiosRequestConfig<{}>) => {
  // Optional pin, e.g. CONFIG_SESSION_PHONE_VERSION=2.3000.1043857760 (Baileys default).
  const pinned = (process.env.CONFIG_SESSION_PHONE_VERSION || '').trim();
  if (/^\d+\.\d+\.\d+$/.test(pinned)) {
    return {
      version: pinned.split('.').map(Number) as WAVersion,
      isLatest: false,
    };
  }

  try {
    const { data } = await axios.get('https://web.whatsapp.com/sw.js', {
      ...options,
      responseType: 'json',
    });

    const regex = /\\?"client_revision\\?":\s*(\d+)/;
    const match = data.match(regex);

    if (!match?.[1]) {
      return {
        version: (await fetchLatestBaileysVersion()).version as WAVersion,
        isLatest: false,
        error: {
          message: 'Could not find client revision in the fetched content',
        },
      };
    }

    const clientRevision = match[1];

    return {
      version: [2, 3000, +clientRevision] as WAVersion,
      isLatest: true,
    };
  } catch (error) {
    return {
      version: (await fetchLatestBaileysVersion()).version as WAVersion,
      isLatest: false,
      error,
    };
  }
};
