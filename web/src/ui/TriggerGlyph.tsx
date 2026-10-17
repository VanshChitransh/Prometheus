// The five triggers as voxel art, like the footer's wordmark: an alarm clock (warn before), a
// run-out hourglass (expired), a document being edited (changed), a flame kept burning (keep,
// Prometheus's fire), a magnifier finding something new (new matches). 12x12 bitmaps; see Voxels.
import type { Trigger } from "../../../shared/schema.ts";
import { Voxels } from "./VoxelWord.tsx";

const COLORS = {
  K: "#3a3a3a", // ink
  W: "#ffffff",
  G: "#b4bac3", // grey
  C: "#dbe7f3", // glass
  O: "#fe7445", // accent
  Y: "#ffa66e",
  L: "#ffe6b0", // the flame's core
  R: "#f2a3b3", // eraser
};

const ART: Record<Trigger, string[]> = {
  expiring: [
    ".OO......OO.",
    "OOO......OOO",
    "OO.KKKKKK.OO",
    "..KWWWOWWK..",
    ".KWWWWOWWWK.",
    ".KWWWWOWWWK.",
    ".KWWWWOOOWK.",
    ".KWWWWWWWWK.",
    ".KWWWWWWWWK.",
    "..KWWWWWWK..",
    "...KKKKKK...",
    "..KK....KK..",
  ],
  expired: [
    "KKKKKKKKKKKK",
    ".GCCCCCCCCG.",
    ".GCCCCCCCCG.",
    "..GCCCCCCG..",
    "...GCCCCG...",
    "....GCCG....",
    "....GCCG....",
    "...GCCCCG...",
    "..GCCCCCCG..",
    ".GCCCOOCCCG.",
    ".GOOOOOOOOG.",
    "KKKKKKKKKKKK",
  ],
  changed: [
    "KKKKKK......",
    "KWWWWKK.....",
    "KWWWWKWK....",
    "KWWWWKKKK..R",
    "KWGGGGWWK.OO",
    "KWWWWWWWKOO.",
    "KWGGGGGWOO..",
    "KWWWWWWOO...",
    "KWGGGWOOK...",
    "KWWWWYYWK...",
    "KWWWWKWWK...",
    "KKKKKKKKK...",
  ],
  keep: [
    ".....O......",
    ".....OO.....",
    "....OOO.....",
    "....OOOO..O.",
    "...OOYOOO.O.",
    "..OOOYYOOOO.",
    "..OOYYYYOOO.",
    ".OOYYLLYYOO.",
    ".OOYLLLLYOO.",
    ".OOYLLLLYOO.",
    "..OOYLLYOO..",
    "...OOOOOO...",
  ],
  new_match: [
    "..KKKK....O.",
    ".KCCCCK..OOO",
    "KCCWCCCK..O.",
    "KCWCCCCK....",
    "KCCCCCCK....",
    "KCCCCCCK....",
    ".KCCCCK.....",
    "..KKKKOO....",
    "......OOO...",
    ".......OOO..",
    "........OOO.",
    ".........OO.",
  ],
};

export function TriggerGlyph({
  trigger,
  className,
}: {
  trigger: Trigger;
  className?: string;
}) {
  return (
    <Voxels
      rows={ART[trigger]}
      colors={COLORS}
      depth={4}
      className={className}
    />
  );
}
