import type { PlumClient } from "./client.js";
import { PlumApiError } from "./errors.js";
import { responseJSON } from "./http.js";
import type { AppEntitlement, AppServiceStatus, EnsureServiceResult } from "./types.js";

/**
 * App-platform calls a companion app makes against the box: is my box-side
 * service installed, and which paid features (SKUs) does this box hold.
 *
 * A companion app never installs anything itself — the box owner confirms an
 * install in the Plum app. `ensureServiceInstalled` tells you whether the
 * service is there and, when it is not, where to send the user.
 */
export class AppsApi {
  constructor(private client: PlumClient) {}

  /**
   * GET /api/apps/{appId}/status — the runtime state of the app's box-side
   * service. Throws a PlumApiError with status 404 when the app is not
   * installed for this user (or has no service).
   */
  async status(appId: string): Promise<AppServiceStatus> {
    const res = await this.client.request(`/api/apps/${encodeURIComponent(appId)}/status`);
    return responseJSON<AppServiceStatus>(res);
  }

  /**
   * Check that the app's service is installed on the box; if it is not,
   * return the links that take the user to install it: `installUrl` opens
   * the Plum app on the store page (`plum://store/<appId>`), `webUrl` opens
   * the box's own web UI for a device without the Plum app. Installation is
   * confirmed by the owner there; afterwards the Plum app returns to your
   * registered redirect URI.
   */
  async ensureServiceInstalled(appId: string): Promise<EnsureServiceResult> {
    try {
      const status = await this.status(appId);
      return { installed: true, status };
    } catch (err) {
      if (err instanceof PlumApiError && err.status === 404) {
        const id = encodeURIComponent(appId);
        return {
          installed: false,
          installUrl: `plum://store/${id}`,
          webUrl: `${this.client.baseUrl}/#/store/${id}?install=1`,
        };
      }
      throw err;
    }
  }

  /**
   * GET /api/apps/{appId}/entitlement — the store receipts this box holds for
   * the app, as the box verified them. Works before the service is
   * installed. Needs a session or a token with `service:call:<appId>` (or a
   * read scope). What a SKU unlocks is up to your app; the box only proves
   * the receipt.
   */
  async entitlement(appId: string): Promise<AppEntitlement> {
    const res = await this.client.request(`/api/apps/${encodeURIComponent(appId)}/entitlement`);
    return responseJSON<AppEntitlement>(res);
  }

  /**
   * POST /api/apps/entitlements/refresh — ask the box to fetch its receipts
   * from the store now (right after a purchase). Returns how many receipts
   * the box now holds.
   */
  async refreshEntitlements(): Promise<number> {
    const res = await this.client.request(`/api/apps/entitlements/refresh`, { method: "POST" });
    return responseJSON<{ receipts: number }>(res).receipts;
  }
}
