```txt
npm install
npm run dev
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

# Membership Management Portal

## Purpose

LHD frequently has new members joining in that need access to software and old members graduating that should be removed from said software. This portal attempts to ease this process of editing permissions for, adding, or removing members of LHD.

## Scope

Currently, we plan to manage accounts for Linear, Figma, Discord, Notion, and Github. This is all software in which users have external accounts and are added into the club's group. What's currently outside of our scope is software the club uses such as Cloudflare and any future SSO.
