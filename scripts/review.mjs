import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
let page=await readFile(new URL('public/index.html',root),'utf8');
const css=await readFile(new URL('public/style.css',root),'utf8');
page=page.replace('<link rel="stylesheet" href="style.css">',()=>'<style>'+css+'</style>');
const app=await readFile(new URL('public/app.js',root),'utf8');
page=page.replace('<script src="app.js"></script>',()=>'<script>window.OC_OFFLINE=true;</script><script>'+app+'</script>');
await writeFile(new URL('review.html',root),page);
