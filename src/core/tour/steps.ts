/**
 * The first-run tour: thirteen stops, fixed in advance.
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
    title: "Welcome to Karen",
    body: "A short tour of where things live — about a minute, thirteen stops. Leave whenever you like; nothing here is required.",
    page: "chat",
  },
  {
    id: "composer",
    title: "Ask anything here",
    body: "This box is the front door. Ask a question, describe what you need written, or drop in something to work from — Karen reads what's here before doing anything else.",
    anchor: "composer",
    page: "chat",
  },
  {
    id: "attach",
    title: "Drop in a paper or an image",
    body: "Drag a PDF, Word file or photo onto the composer, paste one in, or click the clip. A document's text is read into your question; an image is something Karen can look at directly.",
    anchor: "composer-attach",
    page: "chat",
  },
  {
    id: "voice",
    title: "Talk instead of typing",
    body: "Click the microphone to dictate into the box. The wave beside it is speech-to-speech — Karen listens, answers out loud, and keeps listening until you switch it off.",
    anchor: "composer-dictate",
    page: "chat",
  },
  {
    id: "research",
    title: "How far Karen may reach",
    body: "Two rings, one boundary. The left ring never leaves this machine; the right one searches the actual literature and cites what it used. Pick per question — nothing here is a permanent setting.",
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
    body: "Browse and download models sized to what your own hardware can hold — Karen checks your graphics memory before recommending one, so you're not guessing.",
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
    body: "Folders, your microphone, API keys, and exactly what Karen is and isn't allowed to do without asking first. Settings → About also lists exactly what ever leaves this machine, and when.",
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
