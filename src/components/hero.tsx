import Image from "next/image";
import type { ReactNode } from "react";
import { heroImages } from "@/img/hero";

/**
 * Full-bleed landing hero, as on the portfolio: an image band (light/dark
 * variants) fading into the page, with the headline aligned to the column.
 */
export default function Hero({ children }: { children: ReactNode }) {
  const { light, dark, lightPosition, darkPosition } = heroImages;
  return (
    <section aria-labelledby="hero-heading" className="hero">
      <div aria-hidden="true" className="absolute inset-0 -z-10">
        {light ? (
          <>
            {/* Only the active theme's image is displayed; the hidden one is lazy. */}
            <Image
              src={light}
              alt=""
              fill
              sizes="100vw"
              placeholder="blur"
              priority={!dark}
              className={dark ? "hero-image hero-image--light" : "hero-image"}
              style={lightPosition ? { objectPosition: lightPosition } : undefined}
            />
            {dark && (
              <Image
                src={dark}
                alt=""
                fill
                sizes="100vw"
                placeholder="blur"
                loading="lazy"
                className="hero-image hero-image--dark"
                style={darkPosition ? { objectPosition: darkPosition } : undefined}
              />
            )}
          </>
        ) : (
          <div className="hero-placeholder" />
        )}
        <div className="hero-fade" />
      </div>
      <div className="page-col pt-36 pb-10 sm:pb-14">{children}</div>
    </section>
  );
}
