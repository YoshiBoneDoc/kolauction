import { useContext } from 'react';
import { UserContext } from '../context/UserContext';

// Reuse the existing per-user account refresh. No separate timer or profile RPC.
export default function useKolIdentity() {
    const { currentUser } = useContext(UserContext);
    return currentUser && Object.hasOwn(currentUser, 'kolPlayerId')
        ? { kol_player_id: currentUser.kolPlayerId, kol_player_name: currentUser.kolPlayerName } : null;
}
