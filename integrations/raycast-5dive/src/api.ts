import { getPreferenceValues } from "@raycast/api";
import { FiveDive } from "./fivedive";

export function client(): FiveDive {
  const { apiKey, baseUrl, serverToken } = getPreferenceValues<Preferences>();
  return new FiveDive({
    apiKey,
    baseUrl,
    serverToken,
    userAgent: "raycast-5dive",
    settingsName: "the 5dive extension preferences",
  });
}
