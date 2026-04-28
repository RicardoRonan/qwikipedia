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
    if (!canStart() || isLoading()) return;
    startY = e.touches[0].clientY;
    dy = 0;
    pulling = true;
  };

  const onMove = (e) => {
    if (!pulling) return;
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) return;
    setIndicator(dy);
    if (dy > 6) e.preventDefault();
  };

  const onEnd = async () => {
    if (!pulling) return;
    pulling = false;
    const shouldRefresh = dy >= threshold && !isLoading();
    resetIndicator();
    if (shouldRefresh) await onRefresh();
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
