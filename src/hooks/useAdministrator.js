import { useContext } from 'react';
import { UserContext } from '../context/UserContext';

export default function useAdministrator() {
    const { currentUser } = useContext(UserContext);
    return currentUser?.isAdmin === true;
}
