import type { StaticImageData } from "next/image";

/**
 * Landing hero images. Until they're added, the hero shows a neutral
 * placeholder. To use your images, drop them into src/img/ and replace the
 * nulls with static imports, e.g.:
 *
 *   import light from "./hero-background-light.jpg";
 *   import dark from "./hero-background-dark.jpg";
 *   export const heroImages = { light, dark, lightPosition: "35% 60%", darkPosition: "62% 45%" };
 *
 * `dark` may stay null: the light image is then used in both themes.
 */
export const heroImages: {
  light: StaticImageData | null;
  dark: StaticImageData | null;
  lightPosition?: string;
  darkPosition?: string;
} = { light: null, dark: null };
