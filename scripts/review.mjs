import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
let page=await readFile(new URL('public/index.html',root),'utf8');
const css=await readFile(new URL('public/style.css',root),'utf8');
page=page.replace('<link rel="stylesheet" href="style.css">',()=>'<style>'+css+'</style>');
page=page.replace('<script src="sample.js"></script>',()=>'<script>window.OC_OFFLINE=true;</script><script src="sample.js"></script>');
for(const script of ['sample.js','app.js']){
  const js=await readFile(new URL('public/'+script,root),'utf8');
  page=page.replace('<script src="'+script+'"></script>',()=>'<script>'+js+'</script>');
}
await writeFile(new URL('review.html',root),page);
