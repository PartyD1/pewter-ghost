import { impossibleGap, maxGap, knightLimits } from "@jump-tables";
for (const dy of [0,-1,-2,-3,-4,-5,-6, 2]) console.log(dy, impossibleGap(dy,false), impossibleGap(dy,true), maxGap(dy,false,"ULTRA"), maxGap(dy,true,"ULTRA"), maxGap(dy,false), maxGap(dy,true));
console.log(knightLimits("ULTRA"));
