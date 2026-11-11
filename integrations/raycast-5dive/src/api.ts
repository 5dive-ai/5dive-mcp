import { getPreferenceValues } from "@raycast/api";
import { FiveDive } from "./fivedive";

export function client(): FiveDive {
  const { apiKey, baseUrl } = getPreferenceValues<Preferences>();
  return new FiveDive({ apiKey, baseUrl, userAgent: "raycast-5dive" });
}
