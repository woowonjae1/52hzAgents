"use client";

import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState } from "react";
import { sanitizeMermaidSource } from "./mermaid-utils";

let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidInitializedTheme: "default" | "dark" | null = null;
let mermaidRenderSequence = 0;

export function runMermaidRender<T>(task: () => Promise<T>): Promise<T> {
	const run = mermaidRenderQueue.then(task, task);
	mermaidRenderQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export function removeMermaidRenderArtifacts(renderId: string) {
	if (typeof document === "undefined") return;

	document.querySelectorAll(`[id="${renderId}"]`).forEach((node) => {
		const element = node as HTMLElement;
		if (!element.closest(".markdown-content")) {
			element.remove();
		}
	});
}

export function MermaidBlock({
	chart,
	deferErrors,
}: {
	chart: string;
	deferErrors: boolean;
}) {
	const { resolvedTheme } = useTheme();
	const reactId = useId();
	const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		let activeRenderId: string | null = null;
		let errorTimer: ReturnType<typeof setTimeout> | null = null;

		async function renderDiagram() {
			setError(null);

			try {
				await runMermaidRender(async () => {
					if (cancelled) return;

					const mermaid = (await import("mermaid")).default;
					const theme = resolvedTheme === "dark" ? "dark" : "default";
					if (mermaidInitializedTheme !== theme) {
						mermaid.initialize({
							startOnLoad: false,
							securityLevel: "strict",
							theme,
						});
						mermaidInitializedTheme = theme;
					}

					if (cancelled) return;

					activeRenderId = `${renderId}-${Date.now().toString(36)}-${mermaidRenderSequence++}`;
					const cleanChart = sanitizeMermaidSource(chart);
					const result = await mermaid.render(activeRenderId, cleanChart);
					removeMermaidRenderArtifacts(activeRenderId);
					if (!cancelled) {
						setSvg(result.svg);
					}
				});
			} catch (err) {
				if (!cancelled) {
					if (deferErrors) return;

					const message =
						err instanceof Error ? err.message : "Invalid Mermaid syntax";
					errorTimer = setTimeout(() => {
						if (!cancelled) {
							setError(message);
						}
					}, 600);
				}
			} finally {
				if (activeRenderId) {
					removeMermaidRenderArtifacts(activeRenderId);
				}
			}
		}

		const debounceMs = deferErrors ? 250 : 50;
		const renderTimer = setTimeout(() => {
			void renderDiagram();
		}, debounceMs);

		return () => {
			cancelled = true;
			clearTimeout(renderTimer);
			if (errorTimer) {
				clearTimeout(errorTimer);
			}
			if (activeRenderId) {
				removeMermaidRenderArtifacts(activeRenderId);
			}
		};
	}, [chart, deferErrors, renderId, resolvedTheme]);

	useEffect(() => {
		if (svg && containerRef.current) {
			const parser = new DOMParser();
			const doc = parser.parseFromString(svg, "text/html");
			const svgElement = doc.body.firstChild;
			if (svgElement) {
				containerRef.current.replaceChildren(svgElement);
			}
		}
	}, [svg]);

	if (error) {
		return (
			<div className="my-2 rounded-md border border-border-accent bg-surface2 p-3">
				<p className="mb-2 text-xs font-medium text-status-danger">
					Unable to render Mermaid diagram: {error}
				</p>
				<pre className="overflow-x-auto text-[13px] leading-relaxed font-mono text-foreground">
					<code>{chart}</code>
				</pre>
			</div>
		);
	}

	if (!svg) {
		return (
			<div className="my-2 rounded-md border border-border bg-surface1 p-3 text-xs text-muted-foreground">
				Rendering Mermaid diagram...
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="my-2 overflow-x-auto rounded-md border border-border bg-surface0 p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
		/>
	);
}