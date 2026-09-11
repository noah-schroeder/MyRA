/**
 * A review, as something that outlives the page that asked for it.
 *
 * A panel is three requests of up to two thousand words each and takes minutes.
 * Until this existed it lived entirely in the review page's React state, which
 * the window unmounts the moment you look at anything else -- so leaving the tab
 * during a run threw the finished report away while the run itself carried on
 * writing it. A record on disk is what makes leaving the page free.
 *
 * **The manuscript is not part of it.** `main/review.ts` opens by explaining
 * that MyRA never learns where a confidential manuscript lives, and writing the
 * text into `~/Documents` would undo that on the way to a smaller convenience.
 * The word count is kept because it is what the header and the fit message need;
 * the text is held in memory for the length of the run and then let go. The page
 * has to say so, because a record that looks like a document but silently lacks
 * its source is worse than one that explains itself.
 *
 * The pure half, so it is testable with no Electron and no disk. What touches a
 * filesystem lives in [main/review.ts](../../main/review.ts).
 */

export type ReviewStatus = "running" | "done" | "stopped" | "failed";

/** One reviewer's report, under the heading the panel gave them. */
export interface ReviewReport {
  reviewerId: string;
  label: string;
  text: string;
}

export interface Review {
  id: string;
  title: string;
  /** What was dropped in, for the header. A name, never a path. */
  fileName: string;
  /** Measured while the manuscript was in hand; see the note above. */
  words: number;
  studyTypeId: string;
  /**
   * What the panel was called, and the rules it was given, AS SENT.
   *
   * Snapshotted rather than read back from `Settings.reviewPrompt` and
   * `reviewStudyTypes`, which are editable on purpose: a review reopened next
   * month has to show what was actually asked, not what the settings say today.
   */
  studyLabel: string;
  prompt: string;
  note: string;
  /** How many reviewers were asked for, which `reports` grows towards. */
  reviewers: number;
  reports: ReviewReport[];
  /** The whole panel as one document, once there is one. */
  assembled: string;
  /** Citation-shaped text found in the report: reported, never repaired. */
  invented: string[];
  status: ReviewStatus;
  error?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

/** What the list on the front of the page shows, without reading every report. */
export interface ReviewSummary {
  id: string;
  title: string;
  studyLabel: string;
  status: ReviewStatus;
  /** Reviewers finished, out of how many were asked for. */
  done: number;
  total: number;
  words: number;
  updatedAt: string;
}

/**
 * A short, human-legible, filesystem-safe id: date, time, and a title slug.
 *
 * `paperId`'s body, including its use of the local clock rather than UTC -- this
 * name is read in a file manager beside the modification time that manager
 * prints, and the two disagreeing by seven hours reads as a bug in the app.
 */
export function reviewId(title: string, now = new Date(), salt = ""): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 60);
  return `${stamp}-${slug || "review"}${salt ? `-${salt}` : ""}`;
}

/**
 * A review id, refused if it is anything but one.
 *
 * The same guard `assertPaperId` and `assertRunId` are, for the same reason:
 * this comes back from the window to be joined onto the reviews root and then
 * read and deleted.
 */
export function assertReviewId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`no review named ${JSON.stringify(id)}`);
  }
  return id;
}

export function newReview(opts: {
  title: string;
  fileName?: string;
  words: number;
  studyTypeId: string;
  studyLabel: string;
  prompt: string;
  note?: string;
  reviewers: number;
  id?: string;
  now?: Date;
}): Review {
  const now = opts.now ?? new Date();
  const title = opts.title.trim() || "Untitled manuscript";
  const at = now.toISOString();
  return {
    id: opts.id ?? reviewId(title, now),
    title,
    fileName: opts.fileName ?? "",
    words: opts.words,
    studyTypeId: opts.studyTypeId,
    studyLabel: opts.studyLabel,
    prompt: opts.prompt,
    note: opts.note ?? "",
    reviewers: opts.reviewers,
    reports: [],
    assembled: "",
    invented: [],
    status: "running",
    createdAt: at,
    updatedAt: at,
  };
}

export function summaryOf(review: Review): ReviewSummary {
  return {
    id: review.id,
    title: review.title,
    studyLabel: review.studyLabel,
    status: review.status,
    done: review.reports.length,
    /* The record's own count, not `reports.length`: a run stopped after two of
       three has to be able to say which of those two numbers it is. */
    total: review.reviewers || review.reports.length,
    words: review.words,
    updatedAt: review.updatedAt,
  };
}

/** Most recently worked on first, which is the order this list is read in. */
export function byNewest(a: ReviewSummary, b: ReviewSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
}
