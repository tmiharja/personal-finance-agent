"use client";

// Ported from tmiharja/portfolio-website (Reveal) so both sites move the same way.

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  delay?: number;
  className?: string;
};

const hidden = { opacity: 0, y: 12 };
const visible = { opacity: 1, y: 0 };

export default function Reveal({ children, delay = 0, className }: Props) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={hidden}
      animate={reduce ? visible : undefined}
      whileInView={visible}
      viewport={{ once: true, margin: "0px 0px -10% 0px" }}
      transition={reduce ? { duration: 0 } : { duration: 0.35, ease: "easeOut", delay }}
    >
      {children}
    </motion.div>
  );
}
