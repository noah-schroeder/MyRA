/**
 * What MyRA hands a child process.
 *
 * pandoc, pdftotext, tar, `ps`, lemond and every inference engine inherited
 * this process's whole environment. On the machines this app is built for
 * that routinely includes API keys exported in a shell profile for unrelated
 * work. None of these programs needs one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { scrubbedEnv } from "../src/core/childEnv.ts";

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-x",
  OPENAI_API_KEY: "sk-x",
  HF_TOKEN: "hf_x",
  ANTHROPIC_AUTH_TOKEN: "x",
  MYRA_LLM_KEY: "x",
  AWS_SECRET_ACCESS_KEY: "x",
  GH_TOKEN: "ghp_x",
  GITHUB_TOKEN: "ghp_x",
  SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
};

const ORDINARY = { PATH: "/usr/bin", HOME: "/home/u", LANG: "en_GB.UTF-8", LC_ALL: "C", TMPDIR: "/tmp" };

test("no secret reaches a child, whatever it is called", () => {
  const out = scrubbedEnv({ ...ORDINARY, ...SECRETS });
  for (const name of Object.keys(SECRETS)) {
    assert.equal(out[name], undefined, `${name} was handed to a child process`);
  }
});

test("what a program actually needs to run is kept", () => {
  const out = scrubbedEnv({ ...ORDINARY, ...SECRETS });
  assert.equal(out["PATH"], "/usr/bin", "without PATH nothing is found at all");
  assert.equal(out["HOME"], "/home/u");
  assert.equal(out["LANG"], "en_GB.UTF-8");
  assert.equal(out["LC_ALL"], "C", "LC_* is a family, and every member is a locale");
  assert.equal(out["TMPDIR"], "/tmp");
});

test("a tool gets no graphics or proxy variables; an engine does", () => {
  const env = {
    ...ORDINARY,
    VK_ICD_FILENAMES: "/etc/vulkan/icd.d/x.json",
    CUDA_VISIBLE_DEVICES: "0",
    GGML_VK_VISIBLE_DEVICES: "0",
    LD_LIBRARY_PATH: "/opt/rocm/lib",
    HTTPS_PROXY: "http://proxy:3128",
  };
  const tool = scrubbedEnv(env, "tool");
  assert.equal(tool["VK_ICD_FILENAMES"], undefined, "pandoc has no use for a Vulkan loader");
  assert.equal(tool["HTTPS_PROXY"], undefined);

  const engine = scrubbedEnv(env, "engine");
  assert.equal(engine["VK_ICD_FILENAMES"], "/etc/vulkan/icd.d/x.json");
  assert.equal(engine["CUDA_VISIBLE_DEVICES"], "0");
  assert.equal(engine["GGML_VK_VISIBLE_DEVICES"], "0");
  assert.equal(engine["LD_LIBRARY_PATH"], "/opt/rocm/lib", "a working ROCm setup can depend on this");
  assert.equal(engine["HTTPS_PROXY"], "http://proxy:3128", "lemond downloads models");
});

test("what the caller passes explicitly always wins", () => {
  const out = scrubbedEnv({ ...ORDINARY, ...SECRETS }, "engine", {
    LEMONADE_API_KEY: "deliberate",
    PATH: "/opt/myra/bin",
  });
  assert.equal(out["LEMONADE_API_KEY"], "deliberate");
  assert.equal(out["PATH"], "/opt/myra/bin");
});

test("the escape hatch restores the old behaviour exactly", () => {
  /* For somebody whose GPU stack needs a variable this list has not heard of.
     Better than making them wait for a release to get their card back. */
  const out = scrubbedEnv({ ...ORDINARY, ...SECRETS, MYRA_CHILD_ENV: "inherit" });
  assert.equal(out["ANTHROPIC_API_KEY"], "sk-ant-x");
});

test("an unset variable does not become the string 'undefined'", () => {
  const out = scrubbedEnv({ PATH: "/usr/bin", HOME: undefined });
  assert.ok(!("HOME" in out));
});
