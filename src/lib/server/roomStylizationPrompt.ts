export type RoomStylizationPlant = {
  name: string;
  x: number;
  y: number;
};

export function buildRoomStylizationPrompt(plants: RoomStylizationPlant[]) {
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
    "Transform the provided room photo into a cozy 2D cartoon illustration for a mobile plant care app.",
    "",
    "Important constraints:",
    "- Preserve the original image aspect ratio, camera angle, room layout, and object positions.",
    "- Keep every listed plant in the same approximate position so existing app hotspots remain aligned.",
    "- Do not add text, labels, watermarks, UI controls, badges, markers, dots, arrows, or icons.",
    "- Do not draw watering status glows into the image; the app overlays interactive glow effects separately.",
    "- Make plants visually clear and appealing, with slightly stronger contrast than the background.",
    "- Use a warm, friendly, clean 2D cartoon style with soft shapes and gentle lighting.",
    "- Keep furniture, walls, floor, and decor recognizable from the source photo.",
    "- Avoid photorealism and avoid changing the room into a fantasy scene.",
    "",
    "Known plant positions:",
    plantList,
    "",
    "Return only the generated image.",
  ].join("\n");
}
