import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
// Load the view's real functions without attaching DOM event handlers or starting its server calls.
const functions = source.slice(0, source.indexOf('$("#pick").addEventListener'));
function context() {
  const search = { value: "" };
  let confirmation;
  const scope = vm.createContext({
    document: { querySelector: () => search },
    window: { confirm: (message) => { confirmation = message; return false; } },
  });
  vm.runInContext(functions, scope);
  return { scope, search, confirmation: () => confirmation };
}

test("English content queries map to Vision labels without preset places", () => {
  const { scope, search } = context();
  assert.equal(vm.runInContext("PLACES.length", scope), 0);
  for (const term of ["beach", "mountain", "night", "street", "people"]) {
    search.value = term;
    assert.ok(vm.runInContext(`wantedLabels(${JSON.stringify(term)}).length`, scope) > 0, term);
    assert.equal(vm.runInContext("parseQuery().terms[0]", scope), term);
  }
  search.value = "mountain night";
  assert.equal(vm.runInContext("parseQuery().terms.length", scope), 2);
});

test("Trash selection asks for confirmation in English before any file request", async () => {
  const { scope, confirmation } = context();
  await vm.runInContext('trashPhotos([{ path: "sample.jpg", size: 10 }])', scope);
  assert.match(confirmation(), /^Send 1 photo\(s\).*macOS Trash/);
});
