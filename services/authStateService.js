import { auth } from '../firebase';

export const getCurrentAuthUser = () => auth.currentUser;
