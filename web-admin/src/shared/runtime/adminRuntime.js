import { auth, db } from '../../firebase';

export const getAdminDatabase = () => db;
export const getCurrentAdminUser = () => auth.currentUser;
