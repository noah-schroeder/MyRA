import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskSummary } from "../types.ts";
import { monthGrid } from "../../core/time.ts";

/**
 * MyRA's own task list.
 *
 * Deliberately small: one input to add a task, one list to tick items off, a
 * toggle to see what is already done. Most tasks here are not expected to be
 * typed into this page at all -- create_task/list_tasks/complete_task exist
 * as agent tools precisely so "myra, make a task for tomorrow" is the normal
 * way one gets made. This page is where you come to see the result, fix a
 * wrong guess, or add something by hand when you would rather not talk.
 *
 * No `settings` prop, unlike the pages beside it in the rail: nothing here
 * touches a model, a voice, or an endpoint. It is a JSON directory and a
 * checkbox.
 */

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function tomorrowKey(): string {
  const now = new Date();
  now.setDate(now.getDate() + 1);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** A day, said the way a person would say it back -- "Today", "Tomorrow", or
 *  the date itself. Read against the browser's own clock, which is the
 *  renderer's only clock and is always the user's own machine. */
function dueLabel(due: string): string {
  if (due === todayKey()) return "Today";
  if (due === tomorrowKey()) return "Tomorrow";
  return due;
}

/** "2026-09" one month over, wrapping the year. Ordinary local `Date`
 *  arithmetic is fine here -- this is month navigation for a page already
 *  reading the browser's own clock, not a stored value that has to survive
 *  a timezone question. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function TasksPage({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));
  const titleRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    void window.myra.taskList().then((r) => {
      if (r.ok) setTasks(r.tasks);
    });
  }, []);

  useEffect(() => {
    refresh();
    // A late subscriber gets everything on the next push, and the initial
    // fetch above covers the gap before the first one arrives -- the
    // myra:work-state precedent, applied to a much smaller piece of state.
    return window.myra.onTasks(setTasks);
  }, [refresh]);

  const add = async (): Promise<void> => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const result = await window.myra.taskCreate({
        title: trimmed,
        ...(due ? { due } : {}),
        // A reminder with no due date has no day to fire on, so it is only
        // ever sent alongside one -- main/tasks.ts drops it otherwise anyway,
        // but not sending it is the honest version of the same rule.
        ...(due && remindAt ? { remindAt } : {}),
      });
      if (result.ok) {
        setTitle("");
        setDue("");
        setRemindAt("");
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (task: TaskSummary): Promise<void> => {
    // Optimistic: ticking a box that snaps back a moment later reads as
    // broken, and the round trip is a local disk write with nothing to fail
    // beyond a full disk, which is not a case worth a spinner for.
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t)));
    if (task.done) await window.myra.taskReopen(task.id);
    else await window.myra.taskComplete(task.id);
  };

  const remove = async (id: string): Promise<void> => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    await window.myra.taskDelete(id);
  };

  /* Clicking a day in the calendar reuses the ordinary add form rather than
     opening a second way to create a task -- it just pre-fills the date the
     form already has and hands focus to the title, the same as if you had
     picked that date from the input yourself. */
  const pickDay = (day: string): void => {
    setDue(day);
    titleRef.current?.focus();
  };

  const visible = tasks.filter((t) => showDone || !t.done);
  const undatedHidden = view === "calendar" && visible.some((t) => !t.due);

  return (
    <div className={view === "calendar" ? "tasks-page tasks-page-wide" : "tasks-page"}>
      <header className="tasks-page-header">
        <h2>Tasks</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </header>

      <form
        className="tasks-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          ref={titleRef}
          type="text"
          placeholder="Add a task…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          type="date"
          value={due}
          onChange={(e) => {
            setDue(e.target.value);
            // A reminder with no due date has nowhere to fire, so clearing
            // the date clears it too rather than leaving an orphaned time
            // that create() would silently drop anyway.
            if (!e.target.value) setRemindAt("");
          }}
          aria-label="Due date, optional"
        />
        {due ? (
          <input
            type="time"
            value={remindAt}
            onChange={(e) => setRemindAt(e.target.value)}
            aria-label="Remind me at, optional"
            title="Get a notification at this time on the due date"
          />
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
          Add
        </button>
      </form>

      <div className="tasks-toolbar">
        <label className="tasks-show-done">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Show completed
        </label>
        <div className="seg tasks-view-toggle">
          <button type="button" className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
            List
          </button>
          <button
            type="button"
            className={view === "calendar" ? "active" : ""}
            onClick={() => setView("calendar")}
          >
            Calendar
          </button>
        </div>
      </div>

      {view === "calendar" ? (
        <div className="tasks-calendar">
          <div className="cal-head">
            <button type="button" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month">
              ‹
            </button>
            <span className="cal-month-label">{monthLabel(month)}</span>
            <button type="button" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Next month">
              ›
            </button>
            <button type="button" className="linkish" onClick={() => setMonth(todayKey().slice(0, 7))}>
              Today
            </button>
          </div>
          <TaskCalendar month={month} tasks={visible} onToggle={toggle} onDelete={remove} onPickDay={pickDay} />
          {undatedHidden ? (
            <p className="dim cal-undated-hint">
              Some tasks have no due date and do not appear here — switch to List to see them.
            </p>
          ) : null}
        </div>
      ) : visible.length === 0 ? (
        <p className="tasks-empty">
          {tasks.length === 0
            ? "Nothing here yet. Add one above, or ask MyRA to make one for you."
            : 'Nothing open. Tick "Show completed" to see what is done.'}
        </p>
      ) : (
        <ul className="tasks-list">
          {visible.map((task) => (
            <li key={task.id} className={task.done ? "task-row done" : "task-row"}>
              <label className="task-check">
                <input type="checkbox" checked={task.done} onChange={() => void toggle(task)} />
                <span className="task-title">{task.title}</span>
              </label>
              {task.due ? (
                <span className="task-due">
                  {dueLabel(task.due)}
                  {task.remindAt ? ` · ${task.remindAt}` : ""}
                </span>
              ) : null}
              <button
                type="button"
                className="task-delete"
                onClick={() => void remove(task.id)}
                aria-label={`Delete ${task.title}`}
                title="Delete"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The month grid, populated from tasks already loaded by the page --
 *  no IPC of its own, since `Task.due` is already exactly what a calendar
 *  needs to place a task on a cell. */
function TaskCalendar({
  month, tasks, onToggle, onDelete, onPickDay,
}: {
  month: string;
  tasks: TaskSummary[];
  onToggle: (task: TaskSummary) => void;
  onDelete: (id: string) => void;
  onPickDay: (day: string) => void;
}) {
  const grid = monthGrid(`${month}-01`);
  const byDay = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    if (!task.due) continue;
    const existing = byDay.get(task.due);
    if (existing) existing.push(task);
    else byDay.set(task.due, [task]);
  }
  const today = todayKey();

  return (
    <div className="cal-grid">
      {WEEKDAY_LABELS.map((label) => (
        <div key={label} className="cal-weekday">
          {label}
        </div>
      ))}
      {grid.map((day) => {
        const inMonth = day.slice(0, 7) === month;
        const dayTasks = byDay.get(day) ?? [];
        return (
          <div
            key={day}
            className={`cal-cell${inMonth ? "" : " other-month"}${day === today ? " today" : ""}`}
            onClick={() => onPickDay(day)}
          >
            <span className="cal-day-num">{Number(day.slice(8))}</span>
            {dayTasks.length ? (
              <ul className="cal-tasks">
                {dayTasks.map((task) => (
                  <li key={task.id} className={task.done ? "cal-task done" : "cal-task"}>
                    <input
                      type="checkbox"
                      checked={task.done}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        void onToggle(task);
                      }}
                    />
                    <span className="cal-task-title">{task.title}</span>
                    <button
                      type="button"
                      className="cal-task-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDelete(task.id);
                      }}
                      aria-label={`Delete ${task.title}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
