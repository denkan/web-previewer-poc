import type { ExtStoreDO } from './extstore';
import type { CookieJarDO } from './jar';

export interface Env {
	STORE: R2Bucket;
	JARS: DurableObjectNamespace<CookieJarDO>;
	EXT_STORE: DurableObjectNamespace<ExtStoreDO>;
	/** Proxy hosts live at {label}[.http][.live].{SUBDOMAIN_ROOT}. Locally "px.localhost:8787" (Chrome resolves *.localhost). */
	SUBDOMAIN_ROOT: string;
	/** Idle lifetime of a live session's cookie jar (sliding). */
	JAR_IDLE_TTL_SECONDS?: string;
	/** Optional secret (base64, 32 bytes): mixed into the jar key, so a jar needs both the user's key and this to decrypt. */
	JAR_MASTER_KEY?: string;
}
