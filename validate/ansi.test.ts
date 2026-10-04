import { test, expect } from "bun:test";
import { ansiParts, renderAnsi } from "./shared/ansi.js";

test("ANSI colors and styles reset correctly", () => {
  const parts = ansiParts("plain \x1b[1;31mred bold\x1b[22;39m normal");
  expect(parts).toEqual([
    { text: "plain ", style: {} },
    { text: "red bold", style: { fontWeight: "bold", color: "#e06c75" } },
    { text: " normal", style: {} },
  ]);
  expect(ansiParts("\x1b[3;4;9mstyled\x1b[0mclear")[0]!.style).toEqual({ fontStyle: "italic", textDecoration: "underline line-through" });
  expect(ansiParts("\x1b[0mclear")[0]!.style).toEqual({});
});

test("256-color and truecolor foreground/background", () => {
  expect(ansiParts("\x1b[38;5;196;48;2;1;2;3mcolor")[0]!.style).toEqual({ color: "rgb(255, 0, 0)", backgroundColor: "rgb(1, 2, 3)" });
  expect(ansiParts("\x1b[38;5;232mgray")[0]!.style.color).toBe("rgb(8, 8, 8)");
  expect(ansiParts("\x1b[38;2;999;1;2mbad")[0]!.style).toEqual({});
});

test("terminal commands and OSC links discarded, HTML kept as literal text", () => {
  const parts = ansiParts('\x1b[2J\x1b]8;;javascript:alert(1)\x07<img src=x onerror=alert(1)>\x1b]8;;\x07');
  expect(parts).toEqual([{ text: "<img src=x onerror=alert(1)>", style: {} }]);
});

test("rendering creates styled text nodes without HTML parsing", () => {
  const nodes: any[] = [];
  const element = {
    ownerDocument: {
      createDocumentFragment: () => ({ append: (node: any) => nodes.push(node) }),
      createElement: () => ({ textContent: "", style: {} }),
    },
    replaceChildren: () => {},
  };
  renderAnsi(element, "\x1b[32m<script>literal</script>\x1b[0m");
  expect(nodes[0].textContent).toBe("<script>literal</script>");
  expect(nodes[0].style.color).toBe("#98c379");
});
