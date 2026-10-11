/** Minimal subsets of Halo API objects (see swagger.json: Users, Faults, Actions). */

export interface HaloUser {
  id: number;
  name?: string;
  firstname?: string;
  surname?: string;
  emailaddress?: string;
  email2?: string;
  email3?: string;
  phonenumber?: string;
  phonenumber_preferred?: string;
  mobilenumber?: string;
  mobilenumber2?: string;
  homenumber?: string;
  sitephonenumber?: string;
  phonenumberint?: number | string;
  mobileint?: number | string;
  mobilenumber2int?: number | string;
  homenumberint?: number | string;
  client_id?: number;
  client_name?: string;
  site_id?: number;
  site_name?: string;
  inactive?: boolean;
  isserviceaccount?: boolean;
}

export interface HaloTicket {
  id: number;
  summary?: string;
  details?: string;
  status_id?: number;
  status_name?: string;
  client_id?: number;
  client_name?: string;
  site_id?: number;
  user_id?: number;
  user_name?: string;
  agent_id?: number;
  agent_name?: string;
  team?: string;
  dateoccurred?: string;
  lastactiondate?: string;
  dateclosed?: string;
}

export interface HaloAction {
  id: number;
  ticket_id?: number;
  outcome?: string;
  who?: string;
  who_type?: number;
  datetime?: string;
  actiondatecreated?: string;
  note?: string;
  note_html?: string;
  hiddenfromuser?: boolean;
}

export interface HaloClientRecord {
  id: number;
  name?: string;
  inactive?: boolean;
}

export interface ClientList {
  clients?: HaloClientRecord[];
  record_count?: number;
}

export interface UserList {
  users?: HaloUser[];
  record_count?: number;
}
export interface TicketList {
  tickets?: HaloTicket[];
  record_count?: number;
}
export interface ActionList {
  actions?: HaloAction[];
  record_count?: number;
}
