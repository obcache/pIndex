/// <reference types="vite/client" />

import type { PIndexApi } from '../../../preload'

declare global {
  interface Window {
    pindex: PIndexApi
  }
}
