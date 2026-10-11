/** Browser, OS and device class for a session, read from the user agent. */
export interface AgentInfo {
  browser: string;
  os: string;
  device: "Desktop" | "Mobile" | "Tablet";
}

export function describeAgent(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): AgentInfo {
  return { browser: browserOf(ua), os: osOf(ua), device: deviceOf(ua) };
}

function browserOf(ua: string): string {
  // Order matters: Edge and Opera also say Chrome; Chrome also says Safari.
  const rules: Array<[RegExp, string]> = [
    [/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
    [/(?:OPR|Opera)\/(\d+)/, "Opera"],
    [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
    [/FxiOS\/(\d+)/, "Firefox"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/CriOS\/(\d+)/, "Chrome"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+)[\d.]* .*Safari\//, "Safari"],
  ];
  for (const [pattern, name] of rules) {
    const match = pattern.exec(ua);
    if (match) return `${name} ${match[1]}`;
  }
  return "Unknown browser";
}

function osOf(ua: string): string {
  let m: RegExpExecArray | null;
  if ((m = /Windows NT (\d+\.\d+)/.exec(ua))) return m[1] === "10.0" ? "Windows" : `Windows NT ${m[1]}`;
  if ((m = /(?:iPhone|iPad|iPod).*? OS (\d+)/.exec(ua))) return `iOS ${m[1]}`;
  if ((m = /Android (\d+)/.exec(ua))) return `Android ${m[1]}`;
  if ((m = /Mac OS X (\d+)[_.](\d+)/.exec(ua))) return `macOS ${m[1]}.${m[2]}`;
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown OS";
}

function deviceOf(ua: string): AgentInfo["device"] {
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "Tablet";
  if (/Mobi|iPhone|iPod/.test(ua)) return "Mobile";
  return "Desktop";
}
