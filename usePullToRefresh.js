export function usePullToRefresh({
  container,
  indicator,
  threshold = 72,
  isLoading = () => false,
  canStart = () => true,
  onRefresh,
}) {
  if (!container || !indicator || typeof onRefresh !== 'function') return () => {};

  let startY = 0;
  let pulling = false;
  let startTime = 0;
  let dy = 0;
  const label = indicator.querySelector('.ptr-label');
  const spinner = indicator.querySelector('svg');

  const setIndicator = (distance) => {
    const progress = Math.min(distance / threshold, 1);
    const offset = Math.min(distance, threshold + 20);
    indicator.style.transform = `translateX(-50%) translateY(${offset}px)`;
    indicator.style.opacity = String(progress);
    if (spinner) spinner.style.transform = `rotate(${progress * 220}deg)`;
    if (label) label.textContent = progress >= 1 ? 'Release to refresh' : 'Pull to refresh';
  };

  const resetIndicator = () => {
    indicator.style.transition = 'transform 220ms ease, opacity 220ms ease';
    indicator.style.transform = 'translateX(-50%) translateY(0)';
    indicator.style.opacity = '0';
    setTimeout(() => { indicator.style.transition = ''; }, 230);
  };

  const onStart = (e) => {
    if (isLoading()) return;
    if (!canStart()) return;
    startY = e.touches[0].clientY;
    startTime = Date.now();
    dy = 0;
    pulling = true;
    indicator.style.transition = 'none';
  };

  const onMove = (e) => {
    if (!pulling) return;
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      dy = 0;
      return;
    }
    e.preventDefault();
    setIndicator(dy);
  };

  const onEnd = async (e) => {
    if (!pulling) return;
    pulling = false;
    const elapsed = Date.now() - startTime;
    const velocity = elapsed > 0 ? dy / elapsed : 0;
    const shouldRefresh = (dy >= threshold || (dy > threshold * 0.5 && velocity > 0.5)) && !isLoading();
    resetIndicator();
    if (shouldRefresh) {
      try {
        await onRefresh();
      } catch {}
    }
  };

  container.addEventListener('touchstart', onStart, { passive: true });
  container.addEventListener('touchmove', onMove, { passive: false });
  container.addEventListener('touchend', onEnd, { passive: true });

  return () => {
    container.removeEventListener('touchstart', onStart);
    container.removeEventListener('touchmove', onMove);
    container.removeEventListener('touchend', onEnd);
  };
}
