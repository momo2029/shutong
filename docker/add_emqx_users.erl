#!/usr/bin/env escript
%%! -noshell
main(_) ->
    P1 = <<>>,
    P2 = <<>>,
    ok = mnesia:dirty_write({emqx_authn_mnesia, <<"sht_server">>, P1, <<"sht_server">>, erlang:system_time(second), true}),
    io:format("sht_server done~n"),
    ok = mnesia:dirty_write({emqx_authn_mnesia, <<"sht_device">>, P2, <<"sht_device">>, erlang:system_time(second), true}),
    io:format("sht_device done~n"),
    init:stop().
