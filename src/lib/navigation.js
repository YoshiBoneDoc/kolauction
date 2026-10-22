// Resolve nested routes to their parent navigation link. Search/filter parameters
// do not affect the highlighted section.
export function activeNavigationPath(pathname) {
    const path = pathname.replace(/\/+$/, '') || '/';
    if (path === '/') return '/';
    if (path === '/auctions' || path.startsWith('/auction/') || path.startsWith('/seller/')) return '/auctions';
    if (path === '/auction-item') return '/auction-item';
    if (['/info', '/donate', '/support', '/report-a-bug'].includes(path)) return '/info';
    if (path === '/wall-of-shame') return '/wall-of-shame';
    if (path === '/profile' || ['/change-password', '/reset-password'].includes(path)) return '/profile';
    if (path === '/register' || path === '/auth/confirm') return '/register';
    if (['/login', '/forgot-password', '/resend-confirmation'].includes(path)) return '/login';
    if (path.startsWith('/admin/')) return '/admin/inbox';
    return null;
}
