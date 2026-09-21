/**
 * The first-run tour: eighteen stops, fixed in advance.
 *
 * Its own module, with no imports, for the same reason databases.ts is: it has
 * to be readable from the renderer with nothing dragged in behind it, and it
 * has to be the one list both the tour component and its test read, or a step
 * could point at a control that no longer exists without anything failing.
 *
 * `page` is a real navigation, not a hint -- the tour drives the app there so
 * the spotlight lands on the actual Meetings or Models screen rather than a
 * description of one. `anchor`, when present, matches a `data-tour` attribute
 * somewhere in the renderer; more than one element may share an anchor, which
 * is how one step lights both the paper drafter and peer review at once. A
 * step with no anchor is a centred card with nothing dimmed around it.
 */

export type TourPage = "chat" | "models" | "meetings" | "papers" | "runs";

export interface TourStep {
  readonly id: string;
  readonly title: string;
  /** One or two sentences. Names the concrete behaviour, not the feature. */
  readonly body: string;
  readonly anchor?: string;
  readonly page: TourPage;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to MyRA",
    body: "A short tour of where things live — a couple of minutes, eighteen stops, six of them on the one control that decides what MyRA may do on its own. Leave whenever you like; nothing here is required.",
    page: "chat",
  },
  {
    id: "composer",
    title: "Ask anything here",
    body: "This box is the front door. Ask a question, describe what you need written, or drop in something to work from — MyRA reads what's here before doing anything else.",
    anchor: "composer",
    page: "chat",
  },
  {
    id: "attach",
    title: "Drop in a paper or an image",
    body: "Drag a PDF, Word file or photo onto the composer, paste one in, or click the clip. A document's text is read into your question; an image is something MyRA can look at directly.",
    anchor: "composer-attach",
    page: "chat",
  },
  {
    id: "voice",
    title: "Talk instead of typing",
    body: "Click the microphone to dictate into the box. The wave beside it is speech-to-speech — MyRA listens, answers out loud, and keeps listening until you switch it off. Both can be given a keyboard shortcut in Settings → Audio.",
    anchor: "composer-dictate",
    page: "chat",
  },
  /*
   * Six stops on one control, rather than one stop about all of it.
   *
   * It was a single step -- "two rings, one boundary" -- which is the right
   * sentence about the boundary and says nothing about the six buttons either
   * side of it. People were reading the rings as a difficulty setting, Deep
   * as "Quick but better", and never finding Zotero or Look up at all. The
   * control is the one place a person decides what MyRA may do without being
   * asked, so it is the one place worth spending steps on; every step below
   * spotlights the same bar and walks up it a rung at a time.
   */
  {
    id: "mode-off",
    title: "Off: nothing but the model",
    body: "The bar under the box is one control for how far MyRA may reach, and it has a line through the middle. On Off the model has no tools at all — it cannot search, open a link or touch a file, and answers only from what it already knows.",
    anchor: "composer-research",
    page: "chat",
  },
  {
    id: "mode-assistant",
    title: "Assistant: your files and your tasks",
    body: "The model can read and write documents in the folder you chose, and keep your task list — add something, see what's open, tick one off. Nothing leaves this machine.",
    anchor: "composer-research",
    page: "chat",
  },
  {
    id: "mode-zotero",
    title: "Zotero: the papers you already have",
    body: "Everything Assistant does, plus a search of your own Zotero library — the papers you collected and the metadata you corrected. Zotero answers on this machine, so this rung still sends nothing anywhere.",
    anchor: "composer-research",
    page: "chat",
  },
  {
    id: "mode-quick",
    title: "Quick: search the literature",
    body: "The first rung past the line, so this one does reach out. MyRA searches the databases named beside it — OpenAlex and arXiv, plus PubMed and CORE once you add a free key for each — and cites what it used, in seconds, in the conversation.",
    anchor: "composer-research",
    page: "chat",
  },
  {
    id: "mode-deep",
    title: "Deep: a report you can audit",
    body: "Not Quick with more searches — a slower, different job that plans, screens, reads, verifies and writes up. It asks you to scope the question and approve the plan up front, then runs for minutes on its own, and every stage keeps its working.",
    anchor: "composer-research",
    page: "chat",
  },
  {
    id: "mode-lookup",
    title: "Look up: skip the model entirely",
    body: "Search those same databases yourself, with nothing generating an answer in between. It isn't a setting you leave on — stepping away from it puts you back on whichever rung you were using.",
    anchor: "composer-research",
    page: "chat",
  },
  {
    id: "model",
    title: "Who's answering",
    body: "This names the model doing the work, and whether it's running on this machine or a hosted one you've connected. Click it to switch models at any time.",
    anchor: "topbar-model",
    page: "chat",
  },
  {
    id: "models",
    title: "Getting a model onto this machine",
    body: "Browse and download models sized to what your own hardware can hold — MyRA checks your graphics memory before recommending one, so you're not guessing.",
    anchor: "rail-models",
    page: "models",
  },
  {
    id: "meetings",
    title: "Meetings, recorded and checked",
    body: "Records you and the far side of a call as two separate tracks, then writes up notes. Every claim in the notes is checked back against the transcript; anything it can't find is listed as unverified rather than stated as fact.",
    anchor: "rail-meetings",
    page: "meetings",
  },
  {
    id: "writing",
    title: "Drafting and reviewing papers",
    body: "The paper drafter turns your raw notes into a first draft in your own writing voice, and never invents a citation. Peer review does the opposite job: drop in someone else's manuscript and get back a panel's reports.",
    anchor: "rail-writing",
    page: "papers",
  },
  {
    id: "runs",
    title: "The research audit trail",
    body: "Every deep research run keeps its work: the searches it ran, why each source was kept or dropped, and a table checking every claim against where it came from. Nothing here is a black box.",
    anchor: "rail-runs",
    page: "runs",
  },
  {
    id: "projects",
    title: "Keep one piece of work together",
    body: "A project is a folder for one piece of work — open it, and everything you make next files itself there automatically. Your recent conversations, meetings and papers sit just below it either way.",
    anchor: "rail-projects",
    page: "chat",
  },
  {
    id: "settings",
    title: "Everything configurable lives here",
    body: "Folders, your microphone, API keys, and exactly what MyRA is and isn't allowed to do without asking first. Settings → About also lists exactly what ever leaves this machine, and when.",
    anchor: "rail-settings",
    page: "chat",
  },
  {
    id: "done",
    title: "That's the tour",
    body: "Ask it something to get started. You can watch this again any time from Settings → About → Show the tutorial again.",
    page: "chat",
  },
];
