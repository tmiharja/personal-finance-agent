"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import PreviewCard from "./preview-card";
import { errorMessage, type ImportPreview } from "./types";

type Item = {
  key: string;
  name: string;
  file: File;
  status: "queued" | "reading" | "password" | "preview" | "error";
  passwordError?: boolean;
  error?: string;
  preview?: ImportPreview;
};

let seq = 0;

async function upload(
  file: File,
  password?: string,
): Promise<{ preview?: ImportPreview; error?: string }> {
  const form = new FormData();
  form.set("file", file);
  if (password) form.set("password", password);
  const res = await fetch("/api/import", { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as ImportPreview & { error?: string };
  return res.ok ? { preview: body } : { error: body.error ?? "internal_error" };
}

export default function ImportFlow({ initial }: { initial?: ImportPreview | null }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const queue = useRef<Item[]>([]);

  const update = (key: string, patch: Partial<Item>) =>
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  async function run(item: Item, password?: string) {
    update(item.key, { status: "reading", error: undefined, passwordError: false });
    const { preview, error } = await upload(item.file, password);
    if (preview) {
      update(item.key, { status: "preview", preview });
      router.refresh(); // the header's pending-approvals count
    } else if (error === "password_required") update(item.key, { status: "password" });
    else if (error === "password_incorrect")
      update(item.key, { status: "password", passwordError: true });
    else update(item.key, { status: "error", error: errorMessage(error ?? "") });
  }

  async function drain() {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length) await run(queue.current.shift()!);
    busy.current = false;
  }

  function add(files: FileList | null) {
    if (!files?.length) return;
    const next = [...files].map<Item>((file) => ({
      key: `f${++seq}`,
      name: file.name,
      file,
      status: "queued",
    }));
    setItems((list) => [...next, ...list]);
    queue.current.push(...next);
    void drain();
  }

  function submitPassword(item: Item, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = new FormData(e.currentTarget).get("password");
    // Used for this one request and then dropped; never stored or logged.
    void run(item, typeof password === "string" ? password : undefined);
  }

  return (
    <div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-rule hover:bg-accent-soft",
        )}
      >
        <span className="text-[15px] font-medium">Drop statement PDFs here, or choose files</span>
        <span className="mt-1 text-[13px] text-muted">
          DBS and UOB credit-card e-statements · up to 4 MB each
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          aria-label="Statement PDFs"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </label>

      <div className="mt-8 space-y-6">
        {initial && !items.length && <PreviewCard preview={initial} />}
        {items.map((it) => (
          <div key={it.key}>
            {it.status === "preview" && it.preview ? (
              <PreviewCard preview={it.preview} />
            ) : (
              <div className="border-t border-rule pt-4">
                <p className="text-[15px] font-medium break-all">{it.name}</p>
                {(it.status === "queued" || it.status === "reading") && (
                  <p role="status" className="step-pulse mt-1 text-[13px] text-muted">
                    {it.status === "queued" ? "Waiting…" : "Reading, parsing and reconciling…"}
                  </p>
                )}
                {it.status === "password" && (
                  <form onSubmit={(e) => submitPassword(it, e)} className="mt-3 max-w-[420px]">
                    <label htmlFor={`pw-${it.key}`} className="text-[13px] font-medium">
                      This PDF is password-protected. Enter its password.
                    </label>
                    <input
                      id={`pw-${it.key}`}
                      name="password"
                      type="password"
                      autoComplete="off"
                      required
                      className="mt-2 h-11 w-full rounded-lg border border-rule bg-background px-3 text-[15px]"
                    />
                    {it.passwordError && (
                      <p role="alert" className="mt-2 text-[13px] text-danger">
                        {errorMessage("password_incorrect")}
                      </p>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <Button type="submit" size="sm">
                        Unlock
                      </Button>
                      <span className="text-[12px] text-muted">Used once, never stored.</span>
                    </div>
                  </form>
                )}
                {it.status === "error" && (
                  <p
                    role="alert"
                    className="mt-2 rounded-lg bg-danger-soft px-4 py-3 text-[15px] text-danger"
                  >
                    {it.error}
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
