import { FormEvent, useEffect, useMemo, useState } from "react";

type Team = "白班" | "夜班";
type Status = "未检" | "正常" | "异常";

type Field = {
  key: string;
  label: string;
  type?: "number" | "date" | "select";
  options?: string[];
};

type HistoryEntry = {
  id: string;
  team: Team;
  action: "签收" | "确认正常" | "标记异常" | "异常处理";
  note?: string;
  at: string;
};

type Claim = {
  team: Team;
  day: string;
  at: string;
};

type RecordItem = {
  id: string;
  status: Status;
  notes: string;
  createdAt: string;
  // 乐观锁版本号，每次签收/状态变更 +1，防止后提交覆盖先提交
  rev: number;
  // 当天签收信息，按自然日归属；跨天自动失效可由另一班组重新签收
  claim: Claim | null;
  // 签收与处理流水，只追加不改写，供交班核对“谁处理过”
  history: HistoryEntry[];
  item?: string;
  area?: string;
  inspector?: string;
  checkedAt?: string;
  [key: string]: unknown;
};

const TEAMS: Team[] = ["白班", "夜班"];
const TEAM_STORAGE_KEY = "dfwlfront-10-team";
// 模拟服务端提交耗时，方便复现两个班组“几乎同时签收”的竞争场景
const CLAIM_DELAY_MS = 600;

const project = {
  "number": 10,
  "folder": "dfwl/frontend/dfwlfront-10",
  "framework": "react",
  "title": "油站设备巡检清单",
  "subtitle": "两班组共用设备清单：当天签收唯一留痕，异常设备置顶计数，处理完成方可恢复正常。",
  "industry": "石油",
  "stack": [
    "React",
    "Vite",
    "TypeScript",
    "Zustand",
    "Ant Design"
  ],
  "storageKey": "dfwlfront-10-inspection",
  "formTitle": "新增巡检项",
  "primaryAction": "加入清单",
  "entityLabel": "巡检项",
  "statuses": [
    "未检",
    "正常",
    "异常"
  ] as Status[],
  "filters": [
    "全部区域",
    "加油区",
    "油罐区",
    "收银区"
  ],
  "fields": [
    {
      "key": "item",
      "label": "巡检项"
    },
    {
      "key": "area",
      "label": "区域",
      "type": "select",
      "options": [
        "加油区",
        "油罐区",
        "收银区"
      ]
    },
    {
      "key": "inspector",
      "label": "巡检人"
    },
    {
      "key": "checkedAt",
      "label": "巡检日期",
      "type": "date"
    }
  ],
  "records": [
    {
      "item": "加油机1号",
      "area": "加油区",
      "inspector": "何鑫",
      "checkedAt": "2026-06-30",
      "status": "正常",
      "notes": "无异常"
    },
    {
      "item": "卸油口密封",
      "area": "油罐区",
      "inspector": "何鑫",
      "checkedAt": "2026-06-30",
      "status": "异常",
      "notes": "密封圈老化"
    }
  ],
  "metricLabels": [
    "巡检项",
    "待处理异常",
    "今日签收"
  ]
} as const;

const fields = project.fields as unknown as Field[];
const statuses: Status[] = [...project.statuses];
const statusClass: Record<Status, string> = {
  "未检": "status-pending",
  "正常": "status-ok",
  "异常": "status-danger"
};

type Toast = { type: "success" | "error" | "info"; text: string } | null;
type InlineForm = { id: string; mode: "report" | "resolve" } | null;

function todayStr(when = new Date()): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(iso: string): string {
  const when = new Date(iso);
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  const hours = String(when.getHours()).padStart(2, "0");
  const minutes = String(when.getMinutes()).padStart(2, "0");
  const seconds = String(when.getSeconds()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 设备当天的签收班组；签收只在当天有效，跨天自动释放
function ownerOf(record: RecordItem, day = todayStr()): Team | null {
  return record.claim && record.claim.day === day ? record.claim.team : null;
}

function createBlank() {
  return Object.fromEntries(fields.map((field) => [field.key, field.type === "number" ? 0 : ""]));
}

function saveRecords(records: RecordItem[]) {
  localStorage.setItem(project.storageKey, JSON.stringify(records));
}

function readFreshRecords(): RecordItem[] {
  try {
    return JSON.parse(localStorage.getItem(project.storageKey) ?? "[]") as RecordItem[];
  } catch {
    return [];
  }
}

function normalize(record: Partial<RecordItem>, index: number): RecordItem {
  return {
    ...(record as RecordItem),
    id: record.id ?? `seed-${index + 1}`,
    createdAt: record.createdAt ?? new Date(Date.now() - index * 86400000).toISOString(),
    rev: typeof record.rev === "number" ? record.rev : 1,
    claim: record.claim ?? null,
    history: Array.isArray(record.history) ? record.history : []
  };
}

function loadRecords(): RecordItem[] {
  const raw = localStorage.getItem(project.storageKey);
  if (!raw) {
    const seeded = project.records.map((record, index) =>
      normalize({ ...record, rev: 1, claim: null, history: [] }, index)
    );
    saveRecords(seeded);
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RecordItem>[];
    return parsed.map((record, index) => normalize(record, index));
  } catch {
    return [];
  }
}

function primaryText(record: RecordItem) {
  const first = fields[0];
  const second = fields[1];
  return [record[first.key], record[second.key]]
    .map((value) => String(value ?? ""))
    .filter(Boolean)
    .join(" / ") || project.entityLabel;
}

function loadTeam(): Team {
  const saved = sessionStorage.getItem(TEAM_STORAGE_KEY);
  return saved === "白班" || saved === "夜班" ? saved : "白班";
}

export default function App() {
  const [records, setRecords] = useState<RecordItem[]>(loadRecords);
  const [team, setTeam] = useState<Team>(loadTeam);
  const [form, setForm] = useState<Record<string, string | number>>(createBlank);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState<string>(project.filters[0]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inlineForm, setInlineForm] = useState<InlineForm>(null);
  const [inlineNote, setInlineNote] = useState("");
  const [toast, setToast] = useState<Toast>(null);

  // 另一个标签页（另一个班组）写入后，本页立即同步，保证后提交方读到的是最新清单
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === project.storageKey && event.newValue) {
        try {
          setRecords(JSON.parse(event.newValue) as RecordItem[]);
        } catch {
          /* 忽略无法解析的写入 */
        }
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const today = todayStr();

  const visibleRecords = useMemo(() => {
    const filtered = filter.startsWith("全部")
      ? records
      : records.filter((record) => Object.values(record).includes(filter));
    // 异常置顶；其次按今日已签收、建单时间排序
    return [...filtered].sort((a, b) => {
      if (Number(a.status === "异常") !== Number(b.status === "异常")) {
        return Number(b.status === "异常") - Number(a.status === "异常");
      }
      const claimedDiff =
        Number(b.claim?.day === today) - Number(a.claim?.day === today);
      if (claimedDiff !== 0) return claimedDiff;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [filter, records, today]);

  const abnormalRecords = useMemo(() => records.filter((record) => record.status === "异常"), [records]);
  const claimedToday = useMemo(() => records.filter((record) => record.claim?.day === today), [records, today]);
  const claimCountByTeam = TEAMS.map((item) => ({
    team: item,
    count: claimedToday.filter((record) => record.claim?.team === item).length
  }));

  const metrics = [records.length, abnormalRecords.length, claimedToday.length];

  const chartRows = statuses.map((status) => ({
    status,
    value: records.filter((record) => record.status === status).length
  }));
  const maxChart = Math.max(1, ...chartRows.map((row) => row.value));

  function commit(next: RecordItem[]) {
    setRecords(next);
    saveRecords(next);
  }

  function switchTeam(next: Team) {
    setTeam(next);
    sessionStorage.setItem(TEAM_STORAGE_KEY, next);
    setInlineForm(null);
    setInlineNote("");
  }

  // 签收：读取最新清单做原子 check-and-set，已被任何班组当天签收则拒绝覆盖
  async function handleClaim(record: RecordItem) {
    const currentTeam = team;
    setBusyId(record.id);
    await new Promise((resolve) => setTimeout(resolve, CLAIM_DELAY_MS));

    const fresh = readFreshRecords();
    const current = fresh.find((item) => item.id === record.id);
    setBusyId(null);

    if (!current) {
      setRecords(fresh);
      setToast({ type: "error", text: "该设备记录已不存在，清单已刷新" });
      return;
    }
    const owner = ownerOf(current);
    if (owner) {
      // 必须用最新数据回显对方的签收，后提交方明确知道已被谁签收
      setRecords(fresh);
      setToast(
        owner === currentTeam
          ? { type: "info", text: `${currentTeam}今天已签收过「${primaryText(current)}」，无需重复签收` }
          : {
              type: "error",
              text: `「${primaryText(current)}」已于 ${formatTime(current.claim?.at ?? "")} 被${owner}签收，不能覆盖对方记录`
            }
      );
      return;
    }

    const at = new Date().toISOString();
    const next = fresh.map((item) =>
      item.id === record.id
        ? {
            ...item,
            rev: item.rev + 1,
            claim: { team: currentTeam, day: today, at },
            history: [
              ...item.history,
              { id: crypto.randomUUID(), team: currentTeam, action: "签收", at } satisfies HistoryEntry
            ]
          }
        : item
    );
    commit(next);
    setToast({ type: "success", text: `签收成功：${currentTeam}已签收「${primaryText(current)}」，已记录班组与时间` });
  }

  // 签收后的状态变更：只有当天签收本班组才能操作，提交前再次基于最新数据校验
  function applyOwned(recordId: string, apply: (item: RecordItem) => RecordItem): boolean {
    const fresh = readFreshRecords();
    const current = fresh.find((item) => item.id === recordId);
    if (!current) {
      setRecords(fresh);
      setToast({ type: "error", text: "该设备记录已不存在，清单已刷新" });
      return false;
    }
    const owner = ownerOf(current);
    if (!owner) {
      setRecords(fresh);
      setToast({ type: "error", text: "该设备今天尚未签收，请先签收再处理" });
      return false;
    }
    if (owner !== team) {
      setRecords(fresh);
      setToast({ type: "error", text: `该设备由${owner}签收，${team}不能修改对方记录` });
      return false;
    }
    commit(fresh.map((item) => (item.id === recordId ? apply(item) : item)));
    return true;
  }

  function pushHistory(
    item: RecordItem,
    action: HistoryEntry["action"],
    note: string | undefined
  ): HistoryEntry[] {
    return [
      ...item.history,
      { id: crypto.randomUUID(), team, action, at: new Date().toISOString(), ...(note ? { note } : {}) }
    ];
  }

  function openInline(id: string, mode: "report" | "resolve") {
    setInlineForm({ id, mode });
    setInlineNote("");
  }

  function handleReport(id: string) {
    const text = inlineNote.trim();
    if (!text) {
      setToast({ type: "error", text: "请先填写异常现象说明，再提交异常" });
      return;
    }
    const ok = applyOwned(id, (item) => ({
      ...item,
      status: "异常",
      notes: text,
      rev: item.rev + 1,
      history: pushHistory(item, "标记异常", text)
    }));
    if (ok) {
      setToast({ type: "success", text: "已标记异常：该设备已置顶，顶部异常数已更新" });
      setInlineForm(null);
      setInlineNote("");
    }
  }

  function handleResolve(id: string) {
    const text = inlineNote.trim();
    if (!text) {
      setToast({ type: "error", text: "请填写处理措施与结果，异常处理必须留痕" });
      return;
    }
    const ok = applyOwned(id, (item) => ({
      ...item,
      status: "正常",
      notes: text,
      rev: item.rev + 1,
      history: pushHistory(item, "异常处理", text)
    }));
    if (ok) {
      setToast({ type: "success", text: "异常已处理完成，设备恢复正常并退出置顶" });
      setInlineForm(null);
      setInlineNote("");
    }
  }

  function handleMarkNormal(id: string) {
    const ok = applyOwned(id, (item) => ({
      ...item,
      status: "正常",
      rev: item.rev + 1,
      history: pushHistory(item, "确认正常", undefined)
    }));
    if (ok) setToast({ type: "success", text: "已确认正常" });
  }

  function handleDelete(id: string) {
    const fresh = readFreshRecords();
    const current = fresh.find((item) => item.id === id);
    if (current && ownerOf(current)) {
      setRecords(fresh);
      setToast({
        type: "error",
        text: `该设备今天已由${ownerOf(current)}签收留痕，不能删除`
      });
      return;
    }
    commit(fresh.filter((item) => item.id !== id));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 基于最新清单追加，避免把另一标签页刚签收的数据覆盖掉
    const fresh = readFreshRecords();
    const next: RecordItem = {
      ...form,
      id: crypto.randomUUID(),
      status: statuses[0],
      notes: note || "暂无备注",
      createdAt: new Date().toISOString(),
      rev: 1,
      claim: null,
      history: []
    } as RecordItem;
    commit([next, ...fresh]);
    setForm(createBlank());
    setNote("");
    setToast({ type: "success", text: "已加入清单，需当班班组签收后才能处理" });
  }

  return (
    <main className="app">
      <div className="shell">
        {toast && <div className={`toast toast-${toast.type}`}>{toast.text}</div>}

        <header className="topbar">
          <div>
            <p className="eyebrow">{project.industry}行业前端最小闭环</p>
            <h1>{project.title}</h1>
            <p className="subtitle">{project.subtitle}</p>
          </div>
          <div className="stack">{project.stack.map((item) => <span className="tag" key={item}>{item}</span>)}</div>
        </header>

        <section className="shiftbar">
          <div className="shift-left">
            <span className="shift-label">当前班组</span>
            <div className="seg">
              {TEAMS.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={`seg-item${team === item ? " active" : ""}`}
                  onClick={() => switchTeam(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <span className="shift-hint">
              每台设备当天只能由一个班组签收；签收、异常与处理均记录班组和时间，交班时可逐条核对。
            </span>
          </div>
        </section>

        {abnormalRecords.length > 0 && (
          <div className="alert-banner" role="alert">
            <span className="alert-icon">⚠</span>
          当前有 <strong>{abnormalRecords.length}</strong> 台设备异常，已置顶到清单最前；异常处理完成并填写处理说明后，才能恢复成正常。
          </div>
        )}

        <section className="metrics">
          {project.metricLabels.map((label, index) => (
            <article
              className={`metric${index === 1 && metrics[1] > 0 ? " danger" : ""}`}
              key={label}
            >
              <span>{label}</span>
              <strong>{metrics[index]}</strong>
              {index === 2 && (
                <small className="metric-sub">
                  {claimCountByTeam.map((item) => `${item.team} ${item.count}`).join(" · ")}
                </small>
              )}
            </article>
          ))}
        </section>

        <section className="workspace">
          <form className="panel" onSubmit={handleSubmit}>
            <h2>{project.formTitle}</h2>
            <div className="form-grid">
              {fields.map((field) => (
                <label key={field.key}>
                  {field.label}
                  {field.type === "select" ? (
                    <select
                      value={String(form[field.key])}
                      onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                      required
                    >
                      <option value="">请选择</option>
                      {field.options?.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  ) : (
                    <input
                      type={field.type || "text"}
                      value={form[field.key]}
                      onChange={(event) =>
                        setForm({ ...form, [field.key]: field.type === "number" ? Number(event.target.value) : event.target.value })
                      }
                      required
                    />
                  )}
                </label>
              ))}
              <label>
                备注
                <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="填写处理说明或现场备注" />
              </label>
              <button type="submit">{project.primaryAction}</button>
            </div>
          </form>

          <section className="list-panel">
            <div className="toolbar">
              <h2>{project.entityLabel}列表</h2>
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                {project.filters.map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>

            <div className="record-grid">
              {visibleRecords.length === 0 ? <div className="empty">暂无匹配数据</div> : visibleRecords.map((record) => {
                const owner = ownerOf(record);
                const mine = owner === team;
                const busy = busyId === record.id;
                const inline = inlineForm?.id === record.id ? inlineForm.mode : null;
                return (
                  <article
                    className={`record${record.status === "异常" ? " is-abnormal" : ""}${owner ? "" : " unclaimed"}`}
                    key={record.id}
                  >
                    <div className="record-head">
                      <div className="record-head-main">
                        <p className="record-title">{primaryText(record)}</p>
                        {owner ? (
                          <span className={`claim-badge ${mine ? "mine" : "other"}`}>
                            {mine ? `本班组（${owner}）` : `${owner}已签收`} · {formatTime(record.claim?.at ?? "")}{mine ? "" : " · 只读"}
                          </span>
                        ) : (
                          <span className="claim-badge none">今日未签收</span>
                        )}
                      </div>
                      <span className={`status ${statusClass[record.status]}`}>{record.status}</span>
                    </div>
                    <div className="details">
                      {fields.map((field) => (
                        <span key={field.key}>{field.label}: {String(record[field.key] ?? "—")}</span>
                      ))}
                      <span>签收班组: {owner ?? "—"}</span>
                      <span>签收时间: {record.claim?.day === today ? formatTime(record.claim.at) : "—"}</span>
                    </div>
                    <p className="note">{record.notes}</p>

                    <div className="timeline">
                      <p className="timeline-title">签收 / 处理留痕（交班核对）</p>
                      {record.history.length === 0 ? (
                        <span className="timeline-empty">尚无操作记录</span>
                      ) : (
                        [...record.history].reverse().map((entry) => (
                          <div className="timeline-item" key={entry.id}>
                            <span className={`dot dot-${entry.action}`} />
                            <div>
                              <strong>{entry.team} · {entry.action}</strong>
                              <time>{formatTime(entry.at)}</time>
                              {entry.note && <p>{entry.note}</p>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    {inline && (
                      <div className="inline-note">
                        <textarea
                          autoFocus
                          value={inlineNote}
                          onChange={(event) => setInlineNote(event.target.value)}
                          placeholder={inline === "report" ? "描述异常现象，如：密封圈老化、接口渗油……" : "描述处理措施与验收结果，处理留痕必填"}
                        />
                        <div className="inline-actions">
                          <button type="button" onClick={() => (inline === "report" ? handleReport(record.id) : handleResolve(record.id))}>
                            {inline === "report" ? "提交异常" : "完成处理并恢复正常"}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => { setInlineForm(null); setInlineNote(""); }}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="actions">
                      {!owner && (
                        <button type="button" disabled={busyId !== null} onClick={() => handleClaim(record)}>
                          {busy ? "签收中…" : `${team}签收`}
                        </button>
                      )}
                      {mine && record.status === "异常" && !inline && (
                        <button type="button" onClick={() => openInline(record.id, "resolve")}>处理异常</button>
                      )}
                      {mine && record.status !== "异常" && !inline && (
                        <>
                          <button type="button" className="danger-ghost" onClick={() => openInline(record.id, "report")}>
                            标记异常
                          </button>
                          {record.status === "未检" && (
                            <button type="button" onClick={() => handleMarkNormal(record.id)}>确认正常</button>
                          )}
                        </>
                      )}
                      {owner && !mine && <span className="owner-hint">该设备由{owner}签收处理，{team}仅可查看</span>}
                      <button className="secondary" type="button" onClick={() => navigator.clipboard?.writeText(primaryText(record))}>
                        复制摘要
                      </button>
                      {!owner && (
                        <button className="danger" type="button" onClick={() => handleDelete(record.id)}>
                          删除
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="mini-chart">
              {chartRows.map((row) => (
                <div className="bar" key={row.status}>
                  <span>{row.status}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(row.value / maxChart) * 100}%` }} /></div>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
