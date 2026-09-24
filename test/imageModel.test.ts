/**
 * Adding a diffusion model by hand, which is the only way to get one the
 * catalogue does not carry.
 *
 * Every rule asserted here is one lemond 11.8.0 enforces at
 * `POST /api/v1/models/register`, measured against the running daemon. They
 * are checked in MyRA because the daemon's own 400 arrives after the dialog
 * has closed and never says which of the four fields was wrong.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  checkImageModel, IMAGE_PART_ROLES, IMAGE_PART_WORDS, imageModelName,
} from "../src/core/runtime/imageModel.ts";

const MAIN = "unsloth/FLUX.2-klein-9B-GGUF:flux-2-klein-9b-Q8_0.gguf";
const ENCODER = "unsloth/Qwen3-8B-GGUF:Qwen3-8B-Q8_0.gguf";
const VAE = "Comfy-Org/vae-text-encorder-for-flux-klein-9b:split_files/vae/flux2-vae.safetensors";

test("the three parts become the shape the daemon takes", () => {
  const got = checkImageModel({ name: "Flux.2 Klein 9B", parts: { main: MAIN, text_encoder: ENCODER, vae: VAE } });
  assert.ok(got.ok);
  assert.equal(got.record.recipe, "sd-cpp");
  assert.deepEqual(got.record.checkpoints, { main: MAIN, text_encoder: ENCODER, vae: VAE });
});

test("an all-in-one checkpoint is the same form with two fields left blank", () => {
  /* SD-Turbo is one file holding diffusion model, text encoder and VAE
     together -- measured, it loads with all three reported from inside it. Two
     shapes would have been two paths and two sets of bugs. */
  const got = checkImageModel({ name: "SD Turbo", parts: { main: "Green-Sky/SD-Turbo-GGUF:sd_turbo-f16-q8_0.gguf" } });
  assert.ok(got.ok);
  assert.deepEqual(Object.keys(got.record.checkpoints), ["main"]);
});

test("the name is put in the user namespace, which the daemon requires", () => {
  // `Registered model definitions must use a non-empty 'user.*' name` -- a 400.
  assert.equal(imageModelName("Flux.2 Klein 9B"), "user.Flux.2-Klein-9B");
  // Already prefixed is not prefixed twice.
  assert.equal(imageModelName("user.Thing"), "user.Thing");
  assert.equal(imageModelName("   "), "");
});

test("a name that survives nothing is refused rather than sent as `user.`", () => {
  const got = checkImageModel({ name: "///", parts: { main: MAIN } });
  assert.ok(!got.ok);
  assert.equal(got.field, "name");
});

test("the diffusion model is the one part that is never optional", () => {
  const got = checkImageModel({ name: "Thing", parts: { text_encoder: ENCODER } });
  assert.ok(!got.ok);
  assert.equal(got.field, "main");
});

test("an address naming a repository but no file is refused, and says which field", () => {
  /* The daemon's rule for the extra roles is `Additional checkpoints must
     contain an exact repository variant`. Applied to `main` too: the daemon
     would pick a file itself, and for a repository holding thirty
     quantisations that is not a choice to leave to alphabetical order. */
  const got = checkImageModel({ name: "Thing", parts: { main: MAIN, vae: "Comfy-Org/some-repo" } });
  assert.ok(!got.ok);
  assert.equal(got.field, "vae");
  assert.match(got.error, /no file/);
});

test("something that is not an address at all is refused", () => {
  const got = checkImageModel({ name: "Thing", parts: { main: "just some words" } });
  assert.ok(!got.ok);
  assert.equal(got.field, "main");
});

test("every role the form shows has words for it, and main is first", () => {
  // The form renders IMAGE_PART_ROLES directly, so a role with no words is a blank label.
  for (const role of IMAGE_PART_ROLES) assert.ok(IMAGE_PART_WORDS[role]?.label);
  assert.equal(IMAGE_PART_ROLES[0], "main");
});
