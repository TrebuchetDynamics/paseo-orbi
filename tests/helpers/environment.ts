// React Native defines window, but no document or DOM event APIs. Reproduce that
// host global before loading the real QueryClient, which otherwise selects SSR mode.
import { vi } from 'vitest';
vi.stubGlobal('window', {});
