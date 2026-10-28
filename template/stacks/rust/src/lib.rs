pub fn hello(name: &str) -> String {
    format!("hello, {name}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn hello_greets_by_name() {
        assert_eq!(super::hello("proj"), "hello, proj");
    }
}
