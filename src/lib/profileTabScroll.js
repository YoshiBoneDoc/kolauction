// Keep the viewport fixed when a shorter tab replaces a long one. Reserve only
// enough space below the current position to stop the browser clamping scrollY.
export function switchProfileTab({ activity, commit, viewport = window }) {
    if (!activity) { commit();return; }
    const top = viewport.scrollY, left = viewport.scrollX;
    const sectionTop = top + activity.getBoundingClientRect().top;
    const offset = Math.max(0, top - sectionTop);
    activity.style.minHeight = `calc(100vh + ${offset}px)`;
    activity.style.minHeight = `calc(100dvh + ${offset}px)`;
    commit();
    viewport.scrollTo({ left, top, behavior: 'instant' });
}
