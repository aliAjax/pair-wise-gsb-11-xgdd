import { FormEvent, useMemo, useState } from "react";
import {
  addDevice,
  areas,
  deviceStatus,
  fmtDateTime,
  fmtTime,
  LogEntry,
  removeDevice,
  resolveAnomaly,
  Shift,
  signDevice,
  todayStr,
  useSharedData
} from "./store";

const shifts: Shift[] = ["甲班", "乙班"];

type ActiveForm =
  | { kind: "sign-normal" }
  | { kind: "sign-anomaly" }
  | { kind: "resolve" };

const SESSION_KEY = "dfwlfront-10-session";

function loadSession(): { shift: Shift; inspector: string } {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw) as { shift: Shift; inspector: string };
      if (shifts.includes(s.shift)) return s;
    }
  } catch {
    /* 忽略 */
  }
  return { shift: "甲班", inspector: "" };
}

const logStyle: Record<LogEntry["kind"], string> = {
  签收正常: "log-ok",
  异常上报: "log-anomaly",
  异常处理: "log-resolve",
  冲突拦截: "log-conflict",
  新增设备: "log-system",
  移除设备: "log-system"
};

export default function App() {
  const data = useSharedData();
  const [session, setSession] = useState(loadSession);
  const [filter, setFilter] = useState("全部区域");
  const [newName, setNewName] = useState("");
  const [newArea, setNewArea] = useState(areas[0]);
  const [addMsg, setAddMsg] = useState<{ type: "error" | "info"; text: string } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeForm, setActiveForm] = useState<ActiveForm | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [cardMsg, setCardMsg] = useState<{ type: "error" | "info"; text: string } | null>(null);

  function updateSession(patch: Partial<{ shift: Shift; inspector: string }>) {
    const next = { ...session, ...patch };
    setSession(next);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  }

  function openForm(id: string, form: ActiveForm) {
    setActiveId(id);
    setActiveForm(form);
    setNote("");
    setCardMsg(null);
  }

  function closeForm() {
    setActiveId(null);
    setActiveForm(null);
    setNote("");
    setCardMsg(null);
  }

  const anomalyCount = data.devices.filter((d) => deviceStatus(d) === "异常").length;
  const signedToday = data.devices.filter((d) => d.signOff && d.signOff.date === todayStr()).length;
  const pendingCount = data.devices.length - signedToday;

  const filtered = useMemo(() => {
    const list = filter === "全部区域" ? data.devices : data.devices.filter((d) => d.area === filter);
    // 异常设备置顶（稳定排序，其余设备保持清单原顺序）
    return list
      .map((d, i) => ({ d, i }))
      .sort((a, b) => {
        const sa = deviceStatus(a.d) === "异常" ? 0 : 1;
        const sb = deviceStatus(b.d) === "异常" ? 0 : 1;
        return sa - sb || a.i - b.i;
      })
      .map((x) => x.d);
  }, [data.devices, filter]);

  async function handleSign(id: string, result: "正常" | "异常") {
    if (!session.inspector.trim()) {
      setCardMsg({ type: "error", text: "请先在顶部填写本班巡检员姓名" });
      return;
    }
    if (result === "异常" && !note.trim()) {
      setCardMsg({ type: "error", text: "上报异常必须填写异常说明" });
      return;
    }
    setPending(true);
    setCardMsg(null);
    const res = await signDevice({
      deviceId: id,
      shift: session.shift,
      inspector: session.inspector.trim(),
      result,
      note: note.trim()
    });
    setPending(false);
    if (res.status === "ok") {
      closeForm();
    } else if (res.status === "conflict") {
      setCardMsg({
        type: "error",
        text: `这台设备今天已被 ${res.by.shift}·${res.by.inspector}（${fmtTime(res.by.time)}）签收为「${res.by.result}」，你的提交未生效，不能覆盖对方记录`
      });
    } else if (res.status === "blocked-anomaly") {
      setCardMsg({ type: "error", text: "该设备存在未处理异常，需先处理异常后才能重新签收" });
    } else {
      setCardMsg({ type: "error", text: "系统繁忙（另一班组正在提交），请稍后重试" });
    }
  }

  async function handleResolve(id: string) {
    if (!session.inspector.trim()) {
      setCardMsg({ type: "error", text: "请先在顶部填写本班巡检员姓名" });
      return;
    }
    if (!note.trim()) {
      setCardMsg({ type: "error", text: "请填写异常处理说明（处理措施/更换部件等）" });
      return;
    }
    setPending(true);
    setCardMsg(null);
    const res = await resolveAnomaly({
      deviceId: id,
      shift: session.shift,
      operator: session.inspector.trim(),
      note: note.trim()
    });
    setPending(false);
    if (res.status === "ok") {
      closeForm();
    } else if (res.status === "gone") {
      setCardMsg({ type: "info", text: "该异常刚刚已被另一班组处理，记录已恢复为正常" });
      closeForm();
    } else {
      setCardMsg({ type: "error", text: "系统繁忙，请稍后重试" });
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newName.trim()) return;
    if (!session.inspector.trim()) {
      setAddMsg({ type: "error", text: "请先在顶部填写巡检员姓名" });
      return;
    }
    const res = await addDevice({ name: newName, area: newArea, shift: session.shift, operator: session.inspector.trim() });
    if (res.status === "ok") {
      setNewName("");
      setAddMsg({ type: "info", text: "设备已加入共享清单" });
    } else if (res.status === "duplicate") {
      setAddMsg({ type: "error", text: "清单中已存在同名设备" });
    } else {
      setAddMsg({ type: "error", text: "系统繁忙，请稍后重试" });
    }
  }

  return (
    <main className="app">
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">石油行业 · 两班共用设备清单</p>
            <h1>油站设备巡检签收</h1>
            <p className="subtitle">
              每台设备当天仅可被一个班组签收，签收留痕可追溯；异常设备置顶并计入异常数，处理完成后才恢复正常。
            </p>
          </div>
          <div className="terminal">
            <span className="terminal-label">当前终端班组</span>
            <div className="shift-switch">
              {shifts.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={session.shift === s ? `shift-btn shift-${s} on` : "shift-btn"}
                  onClick={() => updateSession({ shift: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            <input
              className="inspector-input"
              value={session.inspector}
              placeholder="本班巡检员姓名"
              onChange={(e) => updateSession({ inspector: e.target.value })}
            />
            <p className="terminal-hint">在另一个浏览器标签页选择「{session.shift === "甲班" ? "乙班" : "甲班"}」即可模拟另一班组同时签收</p>
          </div>
        </header>

        <div className={anomalyCount > 0 ? "alert-banner danger" : "alert-banner"}>
          <span className="alert-icon">{anomalyCount > 0 ? "⚠" : "✓"}</span>
          <div>
            <strong>{anomalyCount > 0 ? `顶部异常：${anomalyCount} 台设备异常待处理` : "当前无未处理异常"}</strong>
            <span>
              {anomalyCount > 0
                ? "异常设备已置顶到清单最前，必须完成异常处理后才能恢复正常"
                : `今日 ${todayStr()}，所有设备均处于正常或待签收状态`}
            </span>
          </div>
        </div>

        <section className="metrics">
          <article className="metric">
            <span>设备总数</span>
            <strong>{data.devices.length}</strong>
          </article>
          <article className="metric">
            <span>今日已签收</span>
            <strong>{signedToday}</strong>
          </article>
          <article className="metric">
            <span>待签收</span>
            <strong>{pendingCount}</strong>
          </article>
          <article className={anomalyCount > 0 ? "metric metric-danger on" : "metric metric-danger"}>
            <span>异常（置顶）</span>
            <strong>{anomalyCount}</strong>
          </article>
        </section>

        <section className="workspace">
          <div className="side-col">
            <form className="panel" onSubmit={handleAdd}>
              <h2>新增设备</h2>
              <div className="form-grid">
                <label>
                  设备名称
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如：加油机3号" required />
                </label>
                <label>
                  所在区域
                  <select value={newArea} onChange={(e) => setNewArea(e.target.value)}>
                    {areas.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
                <button type="submit">加入共享清单</button>
                {addMsg && <p className={addMsg.type === "error" ? "inline-error" : "inline-info"}>{addMsg.text}</p>}
              </div>
            </form>

            <section className="panel log-panel">
              <div className="toolbar">
                <h2>交接留痕</h2>
                <span className="muted">{data.logs.length} 条记录</span>
              </div>
              {data.logs.length === 0 ? (
                <div className="empty">暂无操作记录</div>
              ) : (
                <ul className="log-list">
                  {data.logs.map((log) => (
                    <li key={log.id} className="log-item">
                      <div className="log-top">
                        <span className={`log-kind ${logStyle[log.kind]}`}>{log.kind}</span>
                        <span className="log-time">{fmtDateTime(log.time)}</span>
                      </div>
                      <p className="log-detail">
                        <strong>{log.deviceName}</strong>
                        <span className="muted"> · {log.shift} · {log.operator}</span>
                      </p>
                      <p className="log-note">{log.detail}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="list-panel">
            <div className="toolbar">
              <h2>
                设备签收清单 <span className="muted">（{todayStr()}）</span>
              </h2>
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                {["全部区域", ...areas].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </div>

            <div className="record-grid">
              {filtered.length === 0 ? (
                <div className="empty">该区域暂无设备</div>
              ) : (
                filtered.map((d) => {
                  const status = deviceStatus(d);
                  const isOpen = activeId === d.id;
                  return (
                    <article
                      key={d.id}
                      className={status === "异常" ? "record record-pinned" : "record"}
                    >
                      <div className="record-head">
                        <p className="record-title">
                          {status === "异常" && <span className="pin-badge">置顶</span>}
                          {d.name}
                        </p>
                        <span className={`status status-${status}`}>{status}</span>
                      </div>
                      <div className="details">
                        <span>区域：{d.area}</span>
                        {d.signOff && <span>签收：{d.signOff.shift} · {d.signOff.inspector} · {fmtTime(d.signOff.time)}</span>}
                      </div>

                      {status === "异常" && d.anomaly && (
                        <div className="anomaly-box">
                          <p className="anomaly-text">
                            <strong>异常（{d.signOff ? `${d.signOff.shift}·${d.signOff.inspector} ${fmtTime(d.signOff.time)} 上报` : ""}）：</strong>
                            {d.anomaly.note}
                          </p>
                          {d.resolution && (
                            <p className="resolution-text">
                              处理：{d.resolution.shift}·{d.resolution.operator} {fmtTime(d.resolution.time)} —— {d.resolution.note}
                            </p>
                          )}
                        </div>
                      )}

                      {status === "正常" && (
                        <p className="note">
                          {d.signOff?.note ? `签收备注：${d.signOff.note}` : "今日已签收，无异常"}
                          {d.resolution && (
                            <span className="resolution-line">
                              {" "}｜异常已处理：{d.resolution.shift}·{d.resolution.operator}（{fmtTime(d.resolution.time)}）{d.resolution.note}
                            </span>
                          )}
                        </p>
                      )}

                      {isOpen && activeForm && (
                        <div className="inline-form">
                          <label>
                            {activeForm.kind === "resolve"
                              ? "异常处理说明"
                              : activeForm.kind === "sign-anomaly"
                                ? "异常说明（必填）"
                                : "签收备注（可选）"}
                            <textarea
                              value={note}
                              onChange={(e) => setNote(e.target.value)}
                              placeholder={
                                activeForm.kind === "resolve"
                                  ? "记录处理措施、更换部件、复核结果等"
                                  : activeForm.kind === "sign-anomaly"
                                    ? "如：密封圈老化，已停用挂牌"
                                    : "无异常可留空"
                              }
                            />
                          </label>
                          {cardMsg && <p className={cardMsg.type === "error" ? "inline-error" : "inline-info"}>{cardMsg.text}</p>}
                          <div className="actions">
                            {activeForm.kind === "sign-normal" && (
                              <button type="button" disabled={pending} onClick={() => handleSign(d.id, "正常")}>
                                {pending ? "提交中…（正在做原子校验）" : "确认签收·正常"}
                              </button>
                            )}
                            {activeForm.kind === "sign-anomaly" && (
                              <button className="danger" type="button" disabled={pending} onClick={() => handleSign(d.id, "异常")}>
                                {pending ? "提交中…（正在做原子校验）" : "确认上报异常"}
                              </button>
                            )}
                            {activeForm.kind === "resolve" && (
                              <button className="resolve-btn" type="button" disabled={pending} onClick={() => handleResolve(d.id)}>
                                {pending ? "提交中…" : "确认处理完成，恢复正常"}
                              </button>
                            )}
                            <button className="secondary" type="button" disabled={pending} onClick={closeForm}>
                              取消
                            </button>
                          </div>
                        </div>
                      )}

                      {!isOpen && (
                        <div className="actions">
                          {status === "待签收" && (
                            <>
                              <button type="button" onClick={() => openForm(d.id, { kind: "sign-normal" })}>
                                签收·正常
                              </button>
                              <button className="danger" type="button" onClick={() => openForm(d.id, { kind: "sign-anomaly" })}>
                                上报异常
                              </button>
                              <button
                                className="secondary"
                                type="button"
                                onClick={() => removeDevice({ deviceId: d.id, shift: session.shift, operator: session.inspector.trim() || "未署名" })}
                              >
                                移除
                              </button>
                            </>
                          )}
                          {status === "异常" && (
                            <button className="resolve-btn" type="button" onClick={() => openForm(d.id, { kind: "resolve" })}>
                              处理异常（处理前保持置顶）
                            </button>
                          )}
                          {status === "正常" && (
                            <span className="signed-hint">
                              {d.signOff?.shift === session.shift
                                ? "本班已完成签收"
                                : `今日已由${d.signOff?.shift}签收，不能重复签收`}
                            </span>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })
              )}
            </div>

            <div className="mini-chart">
              {(["待签收", "正常", "异常"] as const).map((s) => {
                const value = data.devices.filter((d) => deviceStatus(d) === s).length;
                const max = Math.max(1, data.devices.length);
                return (
                  <div className="bar" key={s}>
                    <span>{s}</span>
                    <div className="bar-track">
                      <div className={`bar-fill fill-${s}`} style={{ width: `${(value / max) * 100}%` }} />
                    </div>
                    <strong>{value}</strong>
                  </div>
                );
              })}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
