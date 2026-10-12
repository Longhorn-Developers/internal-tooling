import { WorkerEntrypoint } from 'cloudflare:workers'

export class MembershipService extends WorkerEntrypoint<Env> {
  async exampleRPC(params: any) {
    /*
     * D1 data can be accessed via this.env.membership_db.prepare()
     */
    return { /* data */ }
  }
}