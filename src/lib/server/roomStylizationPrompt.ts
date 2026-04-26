export type RoomStylizationPlant = {
  name: string;
  x: number;
  y: number;
};

export type RoomStylizationPreset = "soft" | "medium" | "strong";

function getStyleGoalLines(preset: RoomStylizationPreset) {
  if (preset === "soft") {
    return [
      "Style goals (soft transformation):",
      "- Keep scene highly recognizable while applying gentle cartoon styling.",
      "- Use softer outlines, mild texture simplification, and subtle color flattening.",
      "- Keep natural lighting feel with a light illustrative finish.",
    ];
  }
  if (preset === "medium") {
    return [
      "Style goals (medium transformation):",
      "- Make the room clearly stylized in 2D cartoon look.",
      "- Use visible outlines, moderate cel-shading, and simplified textures.",
      "- Reduce photo-like noise while preserving cozy indoor mood.",
    ];
  }
  return [
    "Style goals (strong transformation):",
    "- Make the result unmistakably cartoon: bold clean outlines, cel-shaded surfaces, simplified textures, painterly color blocks.",
    "- Replace photo-like details/noise with stylized brush-like or flat-color detail while preserving scene structure.",
    "- Keep cozy indoor mood and warm palette, but do not keep photorealistic rendering.",
  ];
}

export function buildRoomStylizationPrompt(
  plants: RoomStylizationPlant[],
  preset: RoomStylizationPreset = "strong",
) {
  const plantList =
    plants.length > 0
      ? plants
          .map(
            (plant, index) =>
              `${index + 1}. ${plant.name} at normalized coordinates x=${plant.x.toFixed(3)}, y=${plant.y.toFixed(3)}`,
          )
          .join("\n")
      : "No named plants were provided. Preserve all visible plants from the source image.";

  return [
    "Restyle the provided room photo into a clearly stylized 2D cartoon scene for a mobile plant care app.",
    "",
    ...getStyleGoalLines(preset),
    "",
    "Geometry constraints (must preserve):",
    "- Preserve original aspect ratio, camera angle, room layout, and relative object locations.",
    "- Keep every listed plant in the same approximate position so existing app hotspots remain aligned.",
    "- Keep furniture, walls, floor, and decor recognizable by shape and placement.",
    "",
    "Output constraints:",
    "- Do not add text, labels, watermarks, UI controls, badges, markers, dots, arrows, or icons.",
    "- Do not draw watering status glows into the image; the app overlays interactive glow effects separately.",
    "- Keep plants visually emphasized versus background using contrast and silhouette clarity.",
    "- Avoid fantasy scene changes and avoid realistic photo look.",
    "",
    "Known plant positions:",
    plantList,
    "",
    "Return only the generated image.",
  ].join("\n");
}
