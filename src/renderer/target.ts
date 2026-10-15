interface Window {
  dragonTarget: {
    onUpdate(cb: (target: { x: number; y: number; number?: number; label: string }) => void): void;
  };
}

window.addEventListener("DOMContentLoaded", () => {
  const marker = document.getElementById("target") as HTMLDivElement;
  const number = document.getElementById("number") as HTMLSpanElement;
  window.dragonTarget.onUpdate((target) => {
    marker.style.left = `${target.x}px`;
    marker.style.top = `${target.y}px`;
    marker.setAttribute("aria-label", target.label);
    marker.classList.toggle("badge-left", target.x > 40);
    marker.classList.toggle("badge-below", target.y < 30);
    number.textContent = target.number == null ? "" : String(target.number);
  });
});
