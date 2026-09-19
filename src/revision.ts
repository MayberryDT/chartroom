import {createHash} from 'node:crypto';
export const revision = (page:any) => createHash('sha256').update(JSON.stringify([page.content_hash,page.updated_at,page.frontmatter,page.deleted_at])).digest('hex');
