create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    email text not null,
    role text not null default 'customer' check (role in ('customer', 'admin')),
    created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
grant select on public.profiles to authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles
        where id = (select auth.uid())
          and role = 'admin'
    );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function public.set_profile_role(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_id uuid;
begin
    if (select auth.uid()) is null or not public.is_admin() then
        raise exception 'Administrator access required';
    end if;

    if p_role is null or p_role not in ('customer', 'admin') then
        raise exception 'Invalid profile role';
    end if;

    if p_email is null or btrim(p_email) = '' then
        raise exception 'Email is required';
    end if;

    select id
    into target_id
    from public.profiles
    where lower(email) = lower(btrim(p_email))
    limit 1;

    if target_id is null then
        raise exception 'No account found for this email';
    end if;

    if target_id = (select auth.uid()) and p_role <> 'admin' then
        raise exception 'You cannot remove your own administrator role';
    end if;

    update public.profiles
    set role = p_role
    where id = target_id;
end;
$$;

revoke all on function public.set_profile_role(text, text) from public;
grant execute on function public.set_profile_role(text, text) to authenticated;

drop policy if exists "Profiles are visible to their owner and admins" on public.profiles;
create policy "Profiles are visible to their owner and admins"
on public.profiles
for select
to authenticated
using (id = (select auth.uid()) or (select public.is_admin()));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do update set email = excluded.email;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

insert into public.profiles (id, email)
select id, email
from auth.users
where email is not null
on conflict (id) do update set email = excluded.email;

create table if not exists public.requests (
    id uuid primary key,
    user_id uuid not null references public.profiles (id) on delete cascade,
    model_path text not null,
    model_name text not null,
    description text not null check (char_length(description) between 1 and 2000),
    status text not null default 'pending'
        check (status in ('pending', 'quoted', 'accepted', 'in_progress', 'completed', 'rejected')),
    quote_amount numeric(10, 2) check (quote_amount is null or quote_amount > 0),
    quote_note text check (quote_note is null or char_length(quote_note) <= 1000),
    created_at timestamptz not null default now()
);

alter table public.requests drop constraint if exists requests_status_check;
alter table public.requests
    add constraint requests_status_check
    check (status in ('pending', 'quoted', 'accepted', 'in_progress', 'completed', 'rejected'));

create index if not exists requests_user_created_at_idx
    on public.requests (user_id, created_at desc);

alter table public.requests enable row level security;

revoke all on public.requests from anon;
grant select, insert, update on public.requests to authenticated;

drop policy if exists "Customers and admins can view requests" on public.requests;
create policy "Customers and admins can view requests"
on public.requests
for select
to authenticated
using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "Customers can create their own pending requests" on public.requests;
create policy "Customers can create their own pending requests"
on public.requests
for insert
to authenticated
with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and quote_amount is null
    and quote_note is null
    and model_path like (select auth.uid())::text || '/' || id::text || '/%'
);

drop policy if exists "Only admins can update requests" on public.requests;
create policy "Only admins can update requests"
on public.requests
for update
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

create or replace function public.accept_quote(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    accepted_id uuid;
begin
    if (select auth.uid()) is null then
        raise exception 'Authentication required';
    end if;

    update public.requests
    set status = 'accepted'
    where id = p_request_id
      and user_id = (select auth.uid())
      and status = 'quoted'
      and quote_amount is not null
    returning id into accepted_id;

    if accepted_id is null then
        raise exception 'This quote is unavailable or has already been accepted';
    end if;
end;
$$;

revoke all on function public.accept_quote(uuid) from public;
grant execute on function public.accept_quote(uuid) to authenticated;

create or replace function public.reject_quote(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    rejected_id uuid;
begin
    if (select auth.uid()) is null then
        raise exception 'Authentication required';
    end if;

    update public.requests
    set status = 'rejected'
    where id = p_request_id
      and user_id = (select auth.uid())
      and status = 'quoted'
      and quote_amount is not null
    returning id into rejected_id;

    if rejected_id is null then
        raise exception 'This quote is unavailable or has already been answered';
    end if;
end;
$$;

revoke all on function public.reject_quote(uuid) from public;
grant execute on function public.reject_quote(uuid) to authenticated;

create or replace function public.set_request_status(p_request_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    updated_id uuid;
begin
    if (select auth.uid()) is null or not public.is_admin() then
        raise exception 'Administrator access required';
    end if;

    if p_status is null or p_status not in ('pending', 'quoted', 'accepted', 'in_progress', 'completed', 'rejected') then
        raise exception 'Invalid request status';
    end if;

    update public.requests
    set status = p_status
    where id = p_request_id
      and (
          p_status not in ('quoted', 'accepted')
          or quote_amount is not null
      )
    returning id into updated_id;

    if updated_id is null then
        raise exception 'Request not found or a quote is required for this status';
    end if;
end;
$$;

revoke all on function public.set_request_status(uuid, text) from public;
grant execute on function public.set_request_status(uuid, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('3d-models', '3d-models', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = 52428800;

drop policy if exists "Customers upload models to their own folder" on storage.objects;
create policy "Customers upload models to their own folder"
on storage.objects
for insert
to authenticated
with check (
    bucket_id = '3d-models'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and lower(storage.extension(name)) in (
        'stl', '3mf', 'obj', 'fbx', 'glb', 'gltf',
        'step', 'stp', 'iges', 'igs', 'ply', 'amf', 'dae', 'blend'
    )
);

drop policy if exists "Customers and admins can read model files" on storage.objects;
create policy "Customers and admins can read model files"
on storage.objects
for select
to authenticated
using (
    bucket_id = '3d-models'
    and (
        (storage.foldername(name))[1] = (select auth.uid())::text
        or (select public.is_admin())
    )
);

drop policy if exists "Customers can remove unlinked model uploads" on storage.objects;
create policy "Customers can remove unlinked model uploads"
on storage.objects
for delete
to authenticated
using (
    bucket_id = '3d-models'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (
        select 1
        from public.requests
        where public.requests.model_path = storage.objects.name
    )
);

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'requests'
    ) then
        alter publication supabase_realtime add table public.requests;
    end if;
end;
$$;

-- After registering the administrator account, run this once and replace the email:
-- update public.profiles set role = 'admin' where email = 'admin@example.com';
