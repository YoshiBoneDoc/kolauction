// Access is loaded from the server; names and player IDs never grant access locally.
export function canViewRaffles(user) {
    return !!user && !user.isBanned && user.canViewRaffles === true;
}
