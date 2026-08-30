import { useCallback, useEffect, useRef, useState } from "react";
import { ratingToPercent } from "../services/ratingCalibration";
import type { RatingPredictionPoint } from "../types";

export function PredictionCanvas({ points }: { points: RatingPredictionPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, bounds.width, bounds.height);
    const style = getComputedStyle(canvas);
    const colors = [style.getPropertyValue("--prediction-low").trim() || "#52745c", style.getPropertyValue("--prediction-medium").trim() || "#b07a3f", style.getPropertyValue("--prediction-high").trim() || "#a14e43"];
    points.forEach((point, index) => {
      const x = ratingToPercent(point.predictedRating) / 100 * bounds.width;
      const y = (100 - ratingToPercent(point.actualRating)) / 100 * bounds.height;
      context.beginPath();
      context.globalAlpha = index === activeIndex ? 1 : .48;
      context.fillStyle = point.absoluteError <= .5 ? colors[0] : point.absoluteError <= 1 ? colors[1] : colors[2];
      context.arc(x, y, index === activeIndex ? 5 : 3.1, 0, Math.PI * 2);
      context.fill();
      if (index === activeIndex) { context.globalAlpha = 1; context.strokeStyle = style.color || "#fff"; context.lineWidth = 1.5; context.stroke(); }
    });
    context.globalAlpha = 1;
  }, [activeIndex, points]);

  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  function nearestIndex(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return null;
    const bounds = canvas.getBoundingClientRect();
    let nearest: number | null = null; let distance = 18 ** 2;
    points.forEach((point, index) => {
      const x = bounds.left + ratingToPercent(point.predictedRating) / 100 * bounds.width;
      const y = bounds.top + (100 - ratingToPercent(point.actualRating)) / 100 * bounds.height;
      const next = (clientX - x) ** 2 + (clientY - y) ** 2;
      if (next <= distance) { distance = next; nearest = index; }
    });
    return nearest;
  }

  const active = activeIndex === null ? undefined : points[activeIndex];
  const activeGroup = active ? points.filter((point) => point.predictedRating === active.predictedRating && point.actualRating === active.actualRating) : [];
  return <div className="prediction-canvas-wrap">
    <canvas
      ref={canvasRef}
      className="prediction-canvas"
      tabIndex={0}
      aria-label={`Prediction graph containing all ${points.length.toLocaleString()} held-out movies. Use arrow keys to inspect movies.`}
      onPointerMove={(event) => setActiveIndex(nearestIndex(event.clientX, event.clientY))}
      onPointerLeave={() => setActiveIndex(null)}
      onClick={(event) => setActiveIndex(nearestIndex(event.clientX, event.clientY))}
      onKeyDown={(event) => {
        if (!points.length || !["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        setActiveIndex((current) => current === null ? 0 : (current + direction + points.length) % points.length);
      }}
    />
    {active && <div className="prediction-canvas-tooltip" style={{ left: `${ratingToPercent(active.predictedRating)}%`, top: `${100 - ratingToPercent(active.actualRating)}%` }} role="status">
      <strong>{activeGroup.length > 1 ? `${activeGroup.length} movies here` : active.movie.title}</strong>
      {activeGroup.length > 1 && <span>{activeGroup.slice(0, 4).map((point) => point.movie.title).join(", ")}{activeGroup.length > 4 ? ` +${activeGroup.length - 4} more` : ""}</span>}
      <small>Predicted {active.predictedRating} · Actual {active.actualRating}</small>
    </div>}
  </div>;
}
