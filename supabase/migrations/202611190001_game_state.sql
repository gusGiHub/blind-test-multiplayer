-- Run once in the Supabase SQL editor. Contains no credentials.
begin;

create table if not exists public.blind_test_runtime (
    namespace text primary key,
    snapshot jsonb,
    expires_at timestamptz not null default now(),
    lock_token uuid,
    lock_until timestamptz
);
alter table public.blind_test_runtime enable row level security;
revoke all on public.blind_test_runtime from public, anon, authenticated;
grant select, insert, update on public.blind_test_runtime to service_role;

create or replace function public.blind_test_store_acquire(p_namespace text, p_token uuid, p_lock_ms integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare acquired public.blind_test_runtime;
begin
    if length(p_namespace) < 1 or length(p_namespace) > 100 or p_lock_ms < 1000 or p_lock_ms > 120000 then
        raise exception 'Invalid store parameters';
    end if;
    insert into public.blind_test_runtime(namespace) values (p_namespace) on conflict do nothing;
    update public.blind_test_runtime
        set lock_token = p_token, lock_until = clock_timestamp() + p_lock_ms * interval '1 millisecond'
        where namespace = p_namespace and (lock_until is null or lock_until <= clock_timestamp())
        returning * into acquired;
    if not found then return jsonb_build_object('acquired', false); end if;
    return jsonb_build_object('acquired', true, 'snapshot', case when acquired.expires_at > clock_timestamp() then acquired.snapshot else null end);
end;
$$;

create or replace function public.blind_test_store_commit(p_namespace text, p_token uuid, p_snapshot jsonb, p_ttl_seconds integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
    if p_ttl_seconds < 1 or p_ttl_seconds > 28800 then raise exception 'Invalid expiry'; end if;
    update public.blind_test_runtime
        set snapshot = p_snapshot, expires_at = clock_timestamp() + p_ttl_seconds * interval '1 second', lock_token = null, lock_until = null
        where namespace = p_namespace and lock_token = p_token and lock_until > clock_timestamp();
    return found;
end;
$$;

create or replace function public.blind_test_store_release(p_namespace text, p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
    update public.blind_test_runtime set lock_token = null, lock_until = null
        where namespace = p_namespace and lock_token = p_token;
    return found;
end;
$$;

revoke execute on function public.blind_test_store_acquire(text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.blind_test_store_commit(text, uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.blind_test_store_release(text, uuid) from public, anon, authenticated;
grant execute on function public.blind_test_store_acquire(text, uuid, integer) to service_role;
grant execute on function public.blind_test_store_commit(text, uuid, jsonb, integer) to service_role;
grant execute on function public.blind_test_store_release(text, uuid) to service_role;

commit;
