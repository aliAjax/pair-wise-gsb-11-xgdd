import { useSyncExternalStore } from "react";

export type Shift = "甲班" | "乙班";
export type Result = "正常" | "异常";

export type SignOff = {
  date: string; // 签收日 YYYY-MM-DD（本地时区）
  shift: Shift;
  inspector: string;
  result: Result;
  note: string;
  time: string; // ISO 时间
};

export type Resolution = {
  shift: Shift;
  operator: string;
  note: string;
  time: string;
};

export type Device = {
  id: string;
  name: string;
  area: string;
  signOff: SignOff | null; // 仅当天有效，跨天自动清空
  anomaly: { note: string; since: string } | null; // 未处理的异常，处理前一直置顶
  resolution: Resolution | null; // 最近一次异常处理记录
};

export type LogKind = "签收正常" | "异常上报" | "异常处理" | "冲突拦截" | "新增设备" | "移除设备";

export type LogEntry = {
  id: string;
  time: string;
  kind: LogKind;
  deviceName: string;
  shift: Shift | "系统";
  operator: string;
  detail: string;
};

export type SharedData = {
  devices: Device[];
  logs: LogEntry[];
};

const DATA_KEY = "dfwlfront-10-inspection-v2";
const LOCK_KEY = `${DATA_KEY}:lock`;
const MAX_LOGS = 200;

const seedDevices: Array<[string, string]> = [
  ["加油机1号", "加油区"],
  ["加油机2号", "加油区"],
  ["油气回收泵", "加油区"],
  ["卸油口密封", "油罐区"],
  ["油罐液位仪", "油罐区"],
  ["消防器材柜", "油罐区"],
  ["收银POS机", "收银区"],
  ["监控摄像头", "收银区"]
];

export const areas = ["加油区", "油罐区", "收银区"];

function seed(): SharedData {
  return {
    devices: seedDevices.map(([name, area], index) => ({
      id: `dev-${index + 1}`,
      name,
      area,
      signOff: null,
      anomaly: null,
      resolution: null
    })),
    logs: []
  };
}

export function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`;
}

export function deviceStatus(d: Device): "异常" | "正常" | "待签收" {
  if (d.anomaly) return "异常";
  if (d.signOff) return "正常";
  return "待签收";
}

// 跨天滚动：昨天的签收记录失效（重新待签收），但未处理的异常继续保留并置顶
function rollover(data: SharedData): SharedData {
  const today = todayStr();
  let changed = false;
  const devices = data.devices.map((d) => {
    if (d.anomaly) return d; // 异常未处理，原样保留
    if (d.signOff && d.signOff.date !== today) {
      changed = true;
      return { ...d, signOff: null, resolution: null };
    }
    if (!d.signOff && d.resolution) {
      changed = true;
      return { ...d, resolution: null };
    }
    return d;
  });
  return changed ? { ...data, devices } : data;
}

function writeData(data: SharedData) {
  localStorage.setItem(DATA_KEY, JSON.stringify(data));
}

function readFresh(): SharedData {
  const raw = localStorage.getItem(DATA_KEY);
  let data: SharedData;
  if (!raw) {
    data = seed();
    writeData(data);
    return data;
  }
  try {
    data = JSON.parse(raw) as SharedData;
  } catch {
    data = seed();
    writeData(data);
    return data;
  }
  const rolled = rollover(data);
  if (rolled !== data) writeData(rolled);
  return rolled;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 基于 localStorage 的互斥锁：签收/处理的"判定 + 写入"在锁内完成，
// 两个班组（两个标签页）同时提交时，后到者拿到锁后重读到的已是对方写入的结果
async function acquireLock(timeoutMs = 3000): Promise<string | null> {
  const token = crypto.randomUUID();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = localStorage.getItem(LOCK_KEY);
    let expired = true;
    if (raw) {
      try {
        expired = (JSON.parse(raw) as { expires: number }).expires < Date.now();
      } catch {
        expired = true;
      }
    }
    if (!raw || expired) {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ token, expires: Date.now() + 5000 }));
      const check = localStorage.getItem(LOCK_KEY);
      if (check && (JSON.parse(check) as { token: string }).token === token) return token;
    }
    await sleep(25 + Math.random() * 40);
  }
  return null;
}

function releaseLock(token: string) {
  const raw = localStorage.getItem(LOCK_KEY);
  if (raw) {
    try {
      if ((JSON.parse(raw) as { token: string }).token === token) localStorage.removeItem(LOCK_KEY);
    } catch {
      /* 忽略 */
    }
  }
}

function makeLog(
  kind: LogKind,
  deviceName: string,
  shift: LogEntry["shift"],
  operator: string,
  detail: string
): LogEntry {
  return { id: crypto.randomUUID(), time: new Date().toISOString(), kind, deviceName, shift, operator, detail };
}

function pushLog(data: SharedData, entry: LogEntry): SharedData {
  return { ...data, logs: [entry, ...data.logs].slice(0, MAX_LOGS) };
}

// ---------- 共享数据的外部 store（跨标签页通过 storage 事件同步） ----------

let shared: SharedData = readFresh();
const listeners = new Set<() => void>();

function setShared(next: SharedData) {
  shared = next;
  listeners.forEach((l) => l());
}

function refreshFromStorage() {
  setShared(readFresh());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSharedData(): SharedData {
  return useSyncExternalStore(subscribe, () => shared);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === DATA_KEY) refreshFromStorage();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshFromStorage();
  });
}

// ---------- 业务操作 ----------

export type SignResult =
  | { status: "ok" }
  | { status: "conflict"; by: SignOff }
  | { status: "blocked-anomaly" }
  | { status: "busy" };

export async function signDevice(input: {
  deviceId: string;
  shift: Shift;
  inspector: string;
  result: Result;
  note: string;
}): Promise<SignResult> {
  // 模拟网络往返，把"提交前重读判定"的竞态窗口暴露出来
  await sleep(200 + Math.random() * 300);
  const token = await acquireLock();
  if (!token) return { status: "busy" };
  try {
    const data = readFresh(); // 锁内重读最新数据，而不是用页面上的旧快照
    const device = data.devices.find((d) => d.id === input.deviceId);
    if (!device) return { status: "busy" };

    if (device.anomaly) {
      const next = pushLog(
        data,
        makeLog("冲突拦截", device.name, input.shift, input.inspector, "设备存在未处理异常，签收被拦截")
      );
      writeData(next);
      setShared(next);
      return { status: "blocked-anomaly" };
    }
    if (device.signOff && device.signOff.date === todayStr()) {
      const next = pushLog(
        data,
        makeLog(
          "冲突拦截",
          device.name,
          input.shift,
          input.inspector,
          `提交时该设备已被 ${device.signOff.shift}·${device.signOff.inspector} 签收，未覆盖对方记录`
        )
      );
      writeData(next);
      setShared(next);
      return { status: "conflict", by: device.signOff };
    }

    const signOff: SignOff = {
      date: todayStr(),
      shift: input.shift,
      inspector: input.inspector,
      result: input.result,
      note: input.note,
      time: new Date().toISOString()
    };
    const devices = data.devices.map((d) =>
      d.id === input.deviceId
        ? input.result === "异常"
          ? { ...d, signOff, anomaly: { note: input.note, since: signOff.time }, resolution: null }
          : { ...d, signOff }
        : d
    );
    let next: SharedData = { ...data, devices };
    next = pushLog(
      next,
      input.result === "异常"
        ? makeLog("异常上报", device.name, input.shift, input.inspector, input.note || "未填写异常说明")
        : makeLog("签收正常", device.name, input.shift, input.inspector, input.note || "无异常")
    );
    writeData(next);
    setShared(next);
    return { status: "ok" };
  } finally {
    releaseLock(token);
  }
}

export type ResolveResult = { status: "ok" } | { status: "gone" } | { status: "busy" };

export async function resolveAnomaly(input: {
  deviceId: string;
  shift: Shift;
  operator: string;
  note: string;
}): Promise<ResolveResult> {
  await sleep(150 + Math.random() * 200);
  const token = await acquireLock();
  if (!token) return { status: "busy" };
  try {
    const data = readFresh();
    const device = data.devices.find((d) => d.id === input.deviceId);
    if (!device) return { status: "busy" };
    if (!device.anomaly) return { status: "gone" }; // 已被另一方处理，直接以最新数据为准

    const resolution: Resolution = {
      shift: input.shift,
      operator: input.operator,
      note: input.note,
      time: new Date().toISOString()
    };
    // 异常处理完毕：恢复为正常。若当天还没有签收记录，处理本身记为当天签收
    const devices = data.devices.map((d) => {
      if (d.id !== input.deviceId) return d;
      const signOff: SignOff =
        d.signOff && d.signOff.date === todayStr()
          ? { ...d.signOff, result: "正常" }
          : {
              date: todayStr(),
              shift: input.shift,
              inspector: input.operator,
              result: "正常",
              note: `异常处理：${input.note}`,
              time: resolution.time
            };
      return { ...d, anomaly: null, resolution, signOff };
    });
    let next: SharedData = { ...data, devices };
    next = pushLog(next, makeLog("异常处理", device.name, input.shift, input.operator, input.note || "异常已处理"));
    writeData(next);
    setShared(next);
    return { status: "ok" };
  } finally {
    releaseLock(token);
  }
}

export type AddResult = { status: "ok" } | { status: "duplicate" } | { status: "busy" };

export async function addDevice(input: { name: string; area: string; shift: Shift; operator: string }): Promise<AddResult> {
  await sleep(100);
  const token = await acquireLock();
  if (!token) return { status: "busy" };
  try {
    const data = readFresh();
    if (data.devices.some((d) => d.name === input.name.trim())) return { status: "duplicate" };
    const device: Device = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      area: input.area,
      signOff: null,
      anomaly: null,
      resolution: null
    };
    let next: SharedData = { ...data, devices: [...data.devices, device] };
    next = pushLog(next, makeLog("新增设备", device.name, input.shift, input.operator, `区域：${input.area}`));
    writeData(next);
    setShared(next);
    return { status: "ok" };
  } finally {
    releaseLock(token);
  }
}

export async function removeDevice(input: { deviceId: string; shift: Shift; operator: string }): Promise<void> {
  const token = await acquireLock();
  if (!token) return;
  try {
    const data = readFresh();
    const device = data.devices.find((d) => d.id === input.deviceId);
    if (!device || device.anomaly || device.signOff) return; // 已签收或有异常的设备不允许移除
    let next: SharedData = { ...data, devices: data.devices.filter((d) => d.id !== input.deviceId) };
    next = pushLog(next, makeLog("移除设备", device.name, input.shift, input.operator, `区域：${device.area}`));
    writeData(next);
    setShared(next);
  } finally {
    releaseLock(token);
  }
}
